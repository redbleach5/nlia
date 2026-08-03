import 'server-only';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { DocumentChunker } from './chunkers/document-chunker';
import { collectFolderFiles } from './folder-utils';
import {
  buildManifestChunks,
  buildManifestConfigUpdate,
  folderFileFingerprint,
} from './folder-manifest';
import type { FolderSourceConfig, DocumentChunkMetadata } from './types';
import type { Chunk } from './types';
import {
  indexEvents,
  abortIndexing,
  isIndexing,
  parseKbFile,
  persistKbChunks,
  persistManifestChunks,
  acquireIndexingController,
  releaseIndexingController,
  waitForIndexing,
  setIndexingMutex,
  clearIndexingMutex,
  finalizeIndexingError,
  type IndexProgress,
} from './indexer';

/**
 * Быстрая индексация папки: только каталог имён/путей (BM25, без Ollama).
 * Содержимое файлов читается on-demand через readFolderFileContent / hydrateKbSearchHits.
 */
export async function indexFolderSource(sourceId: string): Promise<void> {
  // P-CORE-19 fix: serialize concurrent reindex calls per source.
  await waitForIndexing(sourceId);
  let resolveMutex!: () => void;
  const runPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
  setIndexingMutex(sourceId, runPromise);
  try {
    await _indexFolderSourceImpl(sourceId);
  } finally {
    clearIndexingMutex(sourceId);
    resolveMutex();
  }
}

async function _indexFolderSourceImpl(sourceId: string): Promise<void> {
  if (isIndexing(sourceId)) {
    abortIndexing(sourceId);
  }

  // P-CORE-19 fix: waitForIndexing is called by the outer indexFolderSource.
  const controller = acquireIndexingController(sourceId);

  const emitProgress = (p: Omit<IndexProgress, 'sourceId'>) => {
    indexEvents.emit('progress', { sourceId, ...p });
  };

  try {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source || source.type !== 'folder') {
      throw new Error(`Source ${sourceId} not found or not a folder`);
    }

    const config = JSON.parse(source.config) as FolderSourceConfig;

    await db.source.update({
      where: { id: sourceId },
      data: { status: 'indexing', errorMessage: null },
    });

    emitProgress({ phase: 'parsing', processed: 0, total: 0, percent: 0 });

    const files = collectFolderFiles(config.folderPath, controller.signal);
    if (files.length === 0) {
      throw new Error(
        'В папке нет поддерживаемых файлов (.md, .txt, .pdf, .docx). ' +
        'Проверьте путь и содержимое.',
      );
    }

    emitProgress({ phase: 'chunking', processed: 0, total: files.length, percent: 10 });

    const manifestChunks = buildManifestChunks(sourceId, source.name, files);

    const chunkCount = await persistManifestChunks({
      sourceId,
      chunks: manifestChunks,
      controller,
      emitProgress,
    });

    const updatedConfig = buildManifestConfigUpdate(config, files);

    await db.source.update({
      where: { id: sourceId },
      data: {
        status: 'ready',
        lastIndexedAt: new Date(),
        chunkCount,
        errorMessage: null,
        config: JSON.stringify(updatedConfig),
      },
    });

    emitProgress({
      phase: 'done',
      processed: chunkCount,
      total: chunkCount,
      percent: 100,
    });

    logger.info('kb', 'Folder manifest indexed', {
      sourceId: sourceId.slice(0, 8),
      fileCount: files.length,
      chunkCount,
    });
  } catch (e) {
    await finalizeIndexingError(sourceId, e, emitProgress, 'Folder manifest indexing');
  } finally {
    releaseIndexingController(sourceId);
  }
}

/**
 * Полная индексация всех файлов папки (embed). Только по явному запросу reindex?mode=full.
 */
export async function indexFolderSourceFull(sourceId: string): Promise<void> {
  // P-CORE-19 fix: serialize concurrent reindex calls per source.
  await waitForIndexing(sourceId);
  let resolveMutex!: () => void;
  const runPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
  setIndexingMutex(sourceId, runPromise);
  try {
    await _indexFolderSourceFullImpl(sourceId);
  } finally {
    clearIndexingMutex(sourceId);
    resolveMutex();
  }
}

async function _indexFolderSourceFullImpl(sourceId: string): Promise<void> {
  if (isIndexing(sourceId)) {
    abortIndexing(sourceId);
  }

  // P-CORE-19 fix: waitForIndexing is called by the outer indexFolderSourceFull.
  const controller = acquireIndexingController(sourceId);

  const emitProgress = (p: Omit<IndexProgress, 'sourceId'>) => {
    indexEvents.emit('progress', { sourceId, ...p });
  };

  try {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source || source.type !== 'folder') {
      throw new Error(`Source ${sourceId} not found or not a folder`);
    }

    const config = JSON.parse(source.config) as FolderSourceConfig;

    await db.source.update({
      where: { id: sourceId },
      data: { status: 'indexing', errorMessage: null },
    });

    emitProgress({ phase: 'parsing', processed: 0, total: 0, percent: 0 });

    const files = collectFolderFiles(config.folderPath, controller.signal);
    if (files.length === 0) {
      throw new Error(
        'В папке нет поддерживаемых файлов (.md, .txt, .pdf, .docx).',
      );
    }

    const chunker = new DocumentChunker();
    const allChunks: Chunk[] = [];
    const fileHashes: Record<string, string> = {};

    for (let fi = 0; fi < files.length; fi++) {
      if (controller.signal.aborted) throw new Error('aborted');

      const file = files[fi];
      emitProgress({
        phase: 'parsing',
        processed: fi,
        total: files.length,
        percent: Math.round((fi / files.length) * 4),
      });

      try {
        // Same scheme as manifest (mtime+size+path) — shared fileHashes key in config.
        // Chunk-level contentHash from DocumentChunker still tracks content for embeds.
        fileHashes[file.relativePath] = folderFileFingerprint(file.absolutePath);

        const markdown = await parseKbFile(
          file.absolutePath,
          file.mimeType,
          controller.signal,
        );

        const fileChunks = chunker.chunk(markdown, sourceId);
        for (const chunk of fileChunks) {
          const meta = chunk.metadata as DocumentChunkMetadata;
          meta.relativePath = file.relativePath;
          meta.path = meta.heading
            ? `${file.relativePath} > ${meta.path ?? meta.heading}`
            : file.relativePath;
          chunk.metadata = meta;
          chunk.position = allChunks.length;
          allChunks.push(chunk);
        }
      } catch (e) {
        logger.warn('kb', 'Skipping folder file during full indexing', {
          sourceId: sourceId.slice(0, 8),
          file: file.relativePath,
        }, e);
      }
    }

    if (allChunks.length === 0) {
      throw new Error('Не удалось извлечь текст ни из одного файла в папке');
    }

    emitProgress({ phase: 'chunking', processed: allChunks.length, total: allChunks.length, percent: 5 });

    const finalChunkCount = await persistKbChunks({
      sourceId,
      sourceType: source.type,
      chunks: allChunks,
      controller,
      emitProgress,
    });

    const updatedConfig: FolderSourceConfig = {
      ...config,
      indexMode: 'full',
      fileCount: files.length,
      fileHashes,
      contentIndexedCount: files.length,
    };

    await db.source.update({
      where: { id: sourceId },
      data: {
        status: 'ready',
        lastIndexedAt: new Date(),
        chunkCount: finalChunkCount,
        errorMessage: null,
        config: JSON.stringify(updatedConfig),
      },
    });

    emitProgress({
      phase: 'done',
      processed: finalChunkCount,
      total: finalChunkCount,
      percent: 100,
    });

    logger.info('kb', 'Folder fully indexed', {
      sourceId: sourceId.slice(0, 8),
      fileCount: files.length,
      chunkCount: finalChunkCount,
    });
  } catch (e) {
    await finalizeIndexingError(sourceId, e, emitProgress, 'Folder full indexing');
  } finally {
    releaseIndexingController(sourceId);
  }
}
