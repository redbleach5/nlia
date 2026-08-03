import { describe, expect, it } from 'vitest';
import { formatSearchSourcesChunk, relativePathFromChunkMetadata } from '@/lib/kb/search-hit-format';
import type { SearchResult } from '@/lib/kb/types';

function hit(partial: Partial<SearchResult> & Pick<SearchResult, 'id' | 'sourceId' | 'content' | 'metadata' | 'score' | 'matchType'>): SearchResult {
  return {
    sourceName: 'Docs',
    sourceType: 'folder',
    citation: 'Docs > EGTS/doc.docx',
    ...partial,
  };
}

describe('relativePathFromChunkMetadata', () => {
  it('reads relativePath from document metadata', () => {
    expect(relativePathFromChunkMetadata({
      relativePath: 'EGTS/описание.docx',
      manifest: true,
    })).toBe('EGTS/описание.docx');
  });
});

describe('formatSearchSourcesChunk', () => {
  it('exposes chunkId, sourceId, and read_hint for folder manifest hits', () => {
    const formatted = formatSearchSourcesChunk(hit({
      id: 'chunk-uuid',
      sourceId: 'source-uuid',
      content: 'Файл: EGTS/описание.docx',
      metadata: { relativePath: 'EGTS/описание.docx', manifest: true },
      score: 0.91,
      matchType: 'fused',
      sourceType: 'folder',
    }));

    expect(formatted.chunkId).toBe('chunk-uuid');
    expect(formatted.id).toBe('chunk-uuid');
    expect(formatted.sourceId).toBe('source-uuid');
    expect(formatted.relativePath).toBe('EGTS/описание.docx');
    expect(formatted.manifest).toBe(true);
    expect('readHint' in formatted).toBe(true);
    if (!('readHint' in formatted)) throw new Error('Expected read hint for manifest hit');
    expect(formatted.readHint).toContain('read_folder_file');
  });

  it('truncates long content', () => {
    const formatted = formatSearchSourcesChunk(hit({
      id: 'c1',
      sourceId: 's1',
      content: 'x'.repeat(2000),
      metadata: {},
      score: 0.5,
      matchType: 'vector',
      sourceType: 'document',
    }));
    expect(formatted.content.length).toBeLessThan(2000);
    expect(formatted.content.endsWith('…')).toBe(true);
  });
});
