import 'server-only';

// ============================================================================
// Codebase Indexer — главный модуль индексации исходного кода.
// ============================================================================
//
// Этот модуль дополняет существующий KB indexer (src/lib/kb/indexer.ts)
// поддержкой source type 'codebase'.
//
// Основные операции:
//   1. indexCodebaseSource(sourceId) — полная индексация проекта
//   2. reindexCodebaseFile(sourceId, relativePath) — incremental: один файл
//   3. removeCodebaseFile(sourceId, relativePath) — удалился файл
//
// Incremental strategy:
//   - Каждый файл имеет SHA-256 contentHash (в CodebaseSourceConfig.fileHashes)
//   - При reindex сравниваем stored hash vs текущий
//   - Если совпадает → пропускаем файл полностью (no-op)
//   - Если изменился → удаляем старые chunks файла, добавляем новые
//   - Если файла больше нет → удаляем его chunks
//
// Reuse существующей инфраструктуры:
//   - persistKbChunks() из indexer.ts — dual-write (Prisma + kb_vec_virtual)
//   - searchKB() из search.ts — hybrid search (vector + BM25 + RRF)
//   - file-watcher.ts — chokidar для auto-reindex
//
// Gitignore-aware:
//   - Читает .gitignore в корне проекта
//   - По умолчанию исключает node_modules, .git, dist, build, .next, __pycache__
//   - Дополнительно — excludePatterns из config
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { embedBatchForKb } from './embed';
import { finalizeIndexingError, acquireIndexingController, releaseIndexingController, waitForIndexing, setIndexingMutex, clearIndexingMutex, rollbackChunkWrite } from './indexer';
import { insertKbVector } from './db-vec-kb';
import { addToInvertedIndex, removeFromInvertedIndex } from './inverted-index';
import { parseCodeFile } from './code-parser';
import { fileToChunks } from './code-chunker';
import type { Chunk } from './types';

// ============================================================================
// Types
// ============================================================================

export interface CodebaseSourceConfig {
  projectPath: string;
  languages: string[];
  excludePatterns?: string[];
  watchEnabled?: boolean;
  fileHashes?: Record<string, string>;
  fileCount?: number;
  projectGroupId?: string;
}

export interface IndexProgress {
  sourceId: string;
  phase: 'scanning' | 'parsing' | 'embedding' | 'finalizing' | 'done' | 'error';
  processed: number;
  total: number;
  percent: number;
  errorMessage?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.turbo',
  'out',
  '*.lock',
  'package-lock.json',
  'bun.lock',
  'yarn.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
];

const MAX_FILE_SIZE = 512 * 1024; // 512KB — пропускаем огромные файлы
const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py',
]);

// ============================================================================
// Indexing mutex (P-CORE-19 — serialize concurrent runs per source)
// ============================================================================

async function withCodebaseIndexingMutex(sourceId: string, fn: () => Promise<void>): Promise<void> {
  await waitForIndexing(sourceId);
  let resolveMutex!: () => void;
  const runPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
  setIndexingMutex(sourceId, runPromise);
  try {
    await fn();
  } finally {
    clearIndexingMutex(sourceId);
    resolveMutex();
  }
}

// ============================================================================
// Internal: chunk insert + per-file hash persistence
// ============================================================================

async function insertCodebaseChunk(
  chunk: Chunk,
  embedding: Float32Array,
  logContext: { sourceId: string; filePath: string; chunkIndex: number },
): Promise<boolean> {
  try {
    await db.chunk.create({
      data: {
        id: chunk.id,
        sourceId: chunk.sourceId,
        content: chunk.content,
        summary: chunk.summary,
        contentHash: chunk.contentHash,
        metadata: JSON.stringify(chunk.metadata),
        parentId: chunk.parentId,
        position: chunk.position,
      },
    });

    insertKbVector({
      id: chunk.id,
      sourceId: chunk.sourceId,
      sourceType: 'codebase',
      embedding,
    });

    addToInvertedIndex({
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      content: chunk.content,
    });

    return true;
  } catch (e) {
    logger.warn('kb', 'Failed to insert codebase chunk', {
      sourceId: logContext.sourceId.slice(0, 8),
      file: logContext.filePath,
      chunkIndex: logContext.chunkIndex,
    }, e);
    await rollbackChunkWrite(chunk.id);
    return false;
  }
}

/**
 * Insert all chunks for one file. Success only when every chunk is indexed
 * (failed embeddings or insert errors → hash must not advance).
 */
async function indexChunksForCodebaseFile(
  sourceId: string,
  filePath: string,
  chunks: Chunk[],
  embeddings: Array<Float32Array | null | undefined>,
): Promise<{ inserted: number; success: boolean }> {
  if (chunks.length === 0) {
    return { inserted: 0, success: true };
  }

  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) {
      logger.warn('kb', 'Skipping chunk with failed embedding', {
        sourceId: sourceId.slice(0, 8),
        file: filePath,
        chunkIndex: i,
      });
      continue;
    }

    if (await insertCodebaseChunk(chunks[i], embedding, { sourceId, filePath, chunkIndex: i })) {
      inserted++;
    }
  }

  return { inserted, success: inserted === chunks.length };
}

async function persistCodebaseConfig(
  sourceId: string,
  config: CodebaseSourceConfig,
  fileHashes: Record<string, string>,
  fileCount: number,
  options?: { touchLastIndexedAt?: boolean },
): Promise<void> {
  const updatedConfig: CodebaseSourceConfig = {
    ...config,
    fileHashes,
    fileCount,
  };
  const chunkCount = await db.chunk.count({ where: { sourceId } });
  await db.source.update({
    where: { id: sourceId },
    data: {
      config: JSON.stringify(updatedConfig),
      chunkCount,
      ...(options?.touchLastIndexedAt ? { lastIndexedAt: new Date() } : {}),
    },
  });
}

// ============================================================================
// Public: indexCodebaseSource — полная индексация
// ============================================================================

export async function indexCodebaseSource(sourceId: string): Promise<void> {
  await withCodebaseIndexingMutex(sourceId, () => _indexCodebaseSourceImpl(sourceId));
}

async function _indexCodebaseSourceImpl(sourceId: string): Promise<void> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  if (!source || source.type !== 'codebase') {
    throw new Error(`Source ${sourceId} is not a codebase source`);
  }

  const config = JSON.parse(source.config) as CodebaseSourceConfig;
  const controller = acquireIndexingController(sourceId);

  try {
    await db.source.update({
      where: { id: sourceId },
      data: { status: 'indexing', errorMessage: null },
    });

    logger.info('kb', 'Starting codebase indexing', {
      sourceId: sourceId.slice(0, 8),
      projectPath: config.projectPath,
      languages: config.languages,
    });

    // ── 1. Scan files ──
    const filesToIndex = await scanProjectFiles(config);

    // ── 2. Compute hashes, identify changed/removed files ──
    const oldFileHashes = config.fileHashes ?? {};
    const newFileHashes: Record<string, string> = {};
    const changedFiles: string[] = [];
    const unchangedFiles: string[] = [];

    for (const filePath of filesToIndex) {
      const fullPath = path.join(config.projectPath, filePath);
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = await fs.readFile(fullPath, 'utf8');
      const { sha256 } = await import('./code-parser');
      const hash = sha256(content);
      newFileHashes[filePath] = hash;

      if (oldFileHashes[filePath] === hash) {
        unchangedFiles.push(filePath);
      } else {
        changedFiles.push(filePath);
      }
    }

    // Удалённые файлы
    const removedFiles = Object.keys(oldFileHashes).filter(f => !(f in newFileHashes));

    logger.info('kb', 'Codebase reindex plan', {
      sourceId: sourceId.slice(0, 8),
      total: filesToIndex.length,
      changed: changedFiles.length,
      unchanged: unchangedFiles.length,
      removed: removedFiles.length,
    });

    // ── 3. Apply removals (drop hashes + chunks) ──
    const workingHashes: Record<string, string> = { ...oldFileHashes };
    for (const filePath of removedFiles) {
      await deleteChunksForFiles(sourceId, new Set([filePath]));
      delete workingHashes[filePath];
    }
    for (const filePath of unchangedFiles) {
      workingHashes[filePath] = newFileHashes[filePath];
    }

    // ── 4. Reindex changed files one-by-one (delete → insert → hash on success) ──
    // Per-file delete + per-file hash advance: crash or partial insert leaves
    // old hash in config so the file is picked up again on next run.
    let processed = 0;
    const total = changedFiles.length;
    let totalChunksInserted = 0;

    for (const filePath of changedFiles) {
      if (controller.signal.aborted) throw new Error('aborted');

      await deleteChunksForFiles(sourceId, new Set([filePath]));

      const fullPath = path.join(config.projectPath, filePath);
      const content = await fs.readFile(fullPath, 'utf8');

      const parsed = parseCodeFile(filePath, content);
      if (!parsed) {
        workingHashes[filePath] = newFileHashes[filePath];
        await persistCodebaseConfig(sourceId, config, workingHashes, filesToIndex.length);
        processed++;
        continue;
      }

      const chunks = fileToChunks(parsed, sourceId);
      const embeddings = await embedBatchForKb(chunks.map(c => c.content));
      const { inserted, success } = await indexChunksForCodebaseFile(
        sourceId,
        filePath,
        chunks,
        embeddings,
      );
      totalChunksInserted += inserted;

      if (success) {
        workingHashes[filePath] = newFileHashes[filePath];
        await persistCodebaseConfig(sourceId, config, workingHashes, filesToIndex.length);
      } else {
        logger.warn('kb', 'Codebase file indexing incomplete — hash not advanced (will retry)', {
          sourceId: sourceId.slice(0, 8),
          file: filePath,
          inserted,
          expected: chunks.length,
        });
      }

      processed++;
      if (processed % 10 === 0) {
        const percent = total === 0 ? 90 : Math.round((processed / total) * 100);
        logger.info('kb', 'Codebase indexing progress', {
          sourceId: sourceId.slice(0, 8),
          processed,
          total,
          percent,
        });
      }
    }

    // ── 5. Finalize source status ──
    const chunkCount = await db.chunk.count({ where: { sourceId } });

    await db.source.update({
      where: { id: sourceId },
      data: {
        status: 'ready',
        config: JSON.stringify({
          ...config,
          fileHashes: workingHashes,
          fileCount: filesToIndex.length,
        }),
        chunkCount,
        lastIndexedAt: new Date(),
        errorMessage: null,
      },
    });

    logger.info('kb', 'Codebase indexing complete', {
      sourceId: sourceId.slice(0, 8),
      totalChunks: chunkCount,
      chunksInserted: totalChunksInserted,
      filesIndexed: filesToIndex.length,
    });
  } catch (e) {
    // Codebase indexer не стримит SSE-прогресс (в отличие от document/URL/folder),
    // поэтому передаём no-op emitProgress — FinalizeError сам логирует в БД.
    const noopEmit: (p: { phase: 'error'; processed: number; total: number; percent: number; errorMessage: string }) => void = () => {};
    await finalizeIndexingError(sourceId, e, noopEmit, 'Codebase indexing');
    logger.error('kb', 'Codebase indexing failed', { sourceId: sourceId.slice(0, 8) }, e);
    throw e;
  } finally {
    releaseIndexingController(sourceId);
  }
}

// ============================================================================
// Public: reindexCodebaseFile — incremental, single file
// ============================================================================

export async function reindexCodebaseFile(
  sourceId: string,
  relativePath: string,
): Promise<void> {
  await withCodebaseIndexingMutex(sourceId, () => _reindexCodebaseFileImpl(sourceId, relativePath));
}

async function _reindexCodebaseFileImpl(
  sourceId: string,
  relativePath: string,
): Promise<void> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  if (!source || source.type !== 'codebase') return;

  const config = JSON.parse(source.config) as CodebaseSourceConfig;
  const fullPath = path.join(config.projectPath, relativePath);

  try {
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      logger.debug('kb', 'Skipping large file', { relativePath, size: stat.size });
      return;
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const { sha256 } = await import('./code-parser');
    const newHash = sha256(content);

    const oldHash = config.fileHashes?.[relativePath];
    if (oldHash === newHash) {
      logger.debug('kb', 'File unchanged, skipping', { relativePath });
      return;
    }

    await deleteChunksForFiles(sourceId, new Set([relativePath]));

    const parsed = parseCodeFile(relativePath, content);
    if (!parsed) {
      const updatedHashes = { ...config.fileHashes, [relativePath]: newHash };
      await persistCodebaseConfig(sourceId, config, updatedHashes, config.fileCount ?? 0, {
        touchLastIndexedAt: true,
      });
      return;
    }

    const chunks = fileToChunks(parsed, sourceId);
    const controller = acquireIndexingController(sourceId);
    try {
      if (controller.signal.aborted) throw new Error('aborted');

      const embeddings = await embedBatchForKb(chunks.map(c => c.content));
      const { inserted, success } = await indexChunksForCodebaseFile(
        sourceId,
        relativePath,
        chunks,
        embeddings,
      );

      logger.debug('kb', 'Codebase file reindex inserted', {
        sourceId: sourceId.slice(0, 8),
        file: relativePath,
        inserted,
        total: chunks.length,
      });

      if (!success) {
        logger.warn('kb', 'Codebase file reindex incomplete — hash not advanced (will retry)', {
          sourceId: sourceId.slice(0, 8),
          file: relativePath,
          inserted,
          expected: chunks.length,
        });
        return;
      }
    } finally {
      releaseIndexingController(sourceId);
    }

    const updatedHashes = { ...config.fileHashes, [relativePath]: newHash };
    await persistCodebaseConfig(sourceId, config, updatedHashes, config.fileCount ?? 0, {
      touchLastIndexedAt: true,
    });

    logger.info('kb', 'Codebase file reindexed', {
      sourceId: sourceId.slice(0, 8),
      file: relativePath,
      chunks: chunks.length,
    });
  } catch (e) {
    logger.error('kb', 'Codebase file reindex failed', {
      sourceId: sourceId.slice(0, 8),
      file: relativePath,
    }, e);
  }
}

// ============================================================================
// Public: removeCodebaseFile — файл удалён
// ============================================================================

export async function removeCodebaseFile(
  sourceId: string,
  relativePath: string,
): Promise<void> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  if (!source || source.type !== 'codebase') return;

  const config = JSON.parse(source.config) as CodebaseSourceConfig;

  // Удаляем chunks
  await deleteChunksForFiles(sourceId, new Set([relativePath]));

  // Удаляем hash из config
  if (config.fileHashes && relativePath in config.fileHashes) {
    delete config.fileHashes[relativePath];
    const chunkCount = await db.chunk.count({ where: { sourceId } });
    await db.source.update({
      where: { id: sourceId },
      data: {
        config: JSON.stringify(config),
        chunkCount,
      },
    });
  }

  logger.info('kb', 'Codebase file removed', {
    sourceId: sourceId.slice(0, 8),
    file: relativePath,
  });
}

// ============================================================================
// Internal: scanProjectFiles — обходит проект с gitignore-aware
// ============================================================================

async function scanProjectFiles(
  config: CodebaseSourceConfig,
): Promise<string[]> {
  const ig = ignore().add(DEFAULT_EXCLUDES);

  // Загружаем .gitignore если есть
  const gitignorePath = path.join(config.projectPath, '.gitignore');
  try {
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
    ig.add(gitignoreContent);
  } catch {
    // Нет .gitignore — ок
  }

  // Дополнительные exclude patterns из config
  if (config.excludePatterns && config.excludePatterns.length > 0) {
    ig.add(config.excludePatterns);
  }

  const result: string[] = [];
  const rootPath = config.projectPath;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootPath, fullPath);

      // gitignore-aware skip
      if (ig.ignores(relPath)) continue;

      if (entry.isDirectory()) {
        // Пропускаем скрытые папки и node_modules (extra safety)
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        // Если config.languages указан — фильтруем по языку
        if (config.languages.length > 0) {
          const lang = extToLang(ext);
          if (!lang || !config.languages.includes(lang)) continue;
        }

        result.push(relPath.replace(/\\/g, '/')); // normalize для Windows
      }
    }
  }

  await walk(rootPath);
  return result;
}

function extToLang(ext: string): string | null {
  switch (ext) {
    case '.ts': case '.tsx': case '.mts': case '.cts':
      return 'typescript';
    case '.js': case '.jsx': case '.mjs': case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    default:
      return null;
  }
}

// ============================================================================
// Internal: deleteChunksForFiles — удаляет chunks по relativePath
// ============================================================================

async function deleteChunksForFiles(
  sourceId: string,
  filePaths: Set<string>,
): Promise<void> {
  if (filePaths.size === 0) return;

  // Находим все chunks для этих файлов через metadata LIKE
  // metadata — JSON строка, ищем по "filePath":"<path>"
  // Это неэффективно для больших codebases; v2: добавить колонку filePath в Chunk.
  const chunks = await db.chunk.findMany({
    where: {
      sourceId,
      OR: Array.from(filePaths).map(fp => ({
        metadata: { contains: `"filePath":"${fp}"` },
      })),
    },
    select: { id: true, contentHash: true },
  });

  if (chunks.length === 0) return;

  logger.debug('kb', 'Deleting chunks for files', {
    sourceId: sourceId.slice(0, 8),
    filesCount: filePaths.size,
    chunksCount: chunks.length,
  });

  for (const chunk of chunks) {
    try {
      await db.chunk.delete({ where: { id: chunk.id } });
    } catch (e) {
      logger.warn('kb', 'Failed to delete chunk from Prisma', {
        chunkId: chunk.id.slice(0, 8),
      }, e);
      continue;
    }
    try {
      // Удаляем из векторного индекса и inverted index
      const { deleteKbVector } = await import('./db-vec-kb');
      deleteKbVector(chunk.id);
      removeFromInvertedIndex(chunk.id);
    } catch (e) {
      logger.warn('kb', 'Failed to delete chunk indexes', {
        chunkId: chunk.id.slice(0, 8),
      }, e);
    }
  }
}

// ============================================================================
// Public: createCodebaseSource — создаёт новый Source
// ============================================================================

export async function createCodebaseSource(params: {
  name: string;
  projectPath: string;
  languages?: string[];
  excludePatterns?: string[];
  watchEnabled?: boolean;
  tags?: string[];
  projectGroupId?: string;
}): Promise<string> {
  // Resolve realpath для безопасности
  const resolvedPath = await fs.realpath(params.projectPath);

  const config: CodebaseSourceConfig = {
    projectPath: resolvedPath,
    languages: params.languages ?? ['typescript', 'javascript', 'python'],
    excludePatterns: params.excludePatterns,
    watchEnabled: params.watchEnabled ?? true,
    fileHashes: {},
    fileCount: 0,
    ...(params.projectGroupId ? { projectGroupId: params.projectGroupId } : {}),
  };

  const source = await db.source.create({
    data: {
      type: 'codebase',
      name: params.name,
      config: JSON.stringify(config),
      status: 'idle',
      tags: JSON.stringify(params.tags ?? []),
    },
  });

  logger.info('kb', 'Codebase source created', {
    sourceId: source.id.slice(0, 8),
    name: params.name,
    projectPath: resolvedPath,
  });

  return source.id;
}
