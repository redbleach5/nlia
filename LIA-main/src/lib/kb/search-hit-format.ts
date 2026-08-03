import type { ChunkMetadata, DocumentChunkMetadata, SearchResult } from './types';

const SEARCH_CONTENT_LIMIT = 1500;

export function relativePathFromChunkMetadata(metadata: ChunkMetadata): string | undefined {
  if ('relativePath' in metadata && typeof metadata.relativePath === 'string') {
    const p = metadata.relativePath.trim();
    if (p) return p;
  }
  if ('filePath' in metadata && typeof metadata.filePath === 'string') {
    const p = metadata.filePath.trim();
    if (p) return p;
  }
  return undefined;
}

export function isFolderManifestHit(
  metadata: ChunkMetadata,
  sourceType: SearchResult['sourceType'],
): boolean {
  if (sourceType !== 'folder') return false;
  const doc = metadata as DocumentChunkMetadata;
  return doc.manifest === true;
}

/** Формат одного hit для tool search_sources (agent / chat tools). */
export function formatSearchSourcesChunk(r: SearchResult, contentLimit = SEARCH_CONTENT_LIMIT) {
  const relativePath = relativePathFromChunkMetadata(r.metadata);
  const manifest = isFolderManifestHit(r.metadata, r.sourceType);

  const content = r.content.length > contentLimit
    ? r.content.slice(0, contentLimit) + '…'
    : r.content;

  const base = {
    chunkId: r.id,
    /** @deprecated используй chunkId; оставлено для совместимости */
    id: r.id,
    sourceId: r.sourceId,
    content,
    source: r.sourceName,
    sourceType: r.sourceType,
    citation: r.citation,
    score: Math.round(r.score * 1000) / 1000,
    matchType: r.matchType,
    ...(relativePath ? { relativePath } : {}),
    ...(manifest ? { manifest: true as const } : {}),
  };

  if (manifest && relativePath) {
    return {
      ...base,
      readHint: 'Для полного текста: read_folder_file(sourceId, relativePath)',
    };
  }

  return base;
}
