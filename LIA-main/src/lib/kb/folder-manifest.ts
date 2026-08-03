import 'server-only';

import { statSync } from 'fs';
import path from 'path';
import type { Chunk, DocumentChunkMetadata, FolderSourceConfig } from './types';
import { sha256 } from './chunkers/document-chunker';
import type { FolderFileEntry } from './folder-utils';

/** BM25-текст для manifest chunk: имя, путь и токены из имени файла. */
export function buildManifestChunkContent(
  file: FolderFileEntry,
  sourceName: string,
): string {
  const base = path.basename(file.relativePath);
  const pathTokens = file.relativePath
    .replace(/[/\\._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    `Файл: ${file.relativePath}`,
    `Имя: ${base}`,
    `Путь: ${file.relativePath}`,
    pathTokens !== base ? `Ключевые слова: ${pathTokens}` : '',
    `Источник: ${sourceName}`,
  ].filter(Boolean).join('\n');
}

/** Fingerprint for change detection: mtime + size + path (cheap, no content read). */
export function folderFileFingerprint(absolutePath: string): string {
  const stat = statSync(absolutePath);
  return sha256(`${stat.mtimeMs}:${stat.size}:${absolutePath}`).slice(0, 16);
}

export function buildManifestChunks(
  sourceId: string,
  sourceName: string,
  files: FolderFileEntry[],
): Chunk[] {
  return files.map((file, index) => {
    const content = buildManifestChunkContent(file, sourceName);
    const metadata: DocumentChunkMetadata = {
      relativePath: file.relativePath,
      path: file.relativePath,
      manifest: true,
    };

    return {
      id: crypto.randomUUID(),
      sourceId,
      content,
      contentHash: sha256(`manifest-v1:${file.relativePath}:${folderFileFingerprint(file.absolutePath)}`),
      metadata,
      parentId: null,
      position: index,
    };
  });
}

export function isManifestChunk(metadata: DocumentChunkMetadata | undefined): boolean {
  return metadata?.manifest === true;
}

export function buildManifestConfigUpdate(
  config: FolderSourceConfig,
  files: FolderFileEntry[],
): FolderSourceConfig {
  const fileHashes: Record<string, string> = {};
  for (const f of files) {
    try {
      fileHashes[f.relativePath] = folderFileFingerprint(f.absolutePath);
    } catch {
      // skip unreadable
    }
  }

  return {
    ...config,
    indexMode: 'manifest',
    fileCount: files.length,
    fileHashes,
    contentIndexedCount: 0,
  };
}
