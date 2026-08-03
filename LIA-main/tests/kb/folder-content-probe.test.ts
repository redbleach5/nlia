import { describe, expect, it } from 'vitest';
import { extractContentIdentifiers } from '@/lib/kb/kb-query-filter';
import {
  scoreManifestPath,
  shouldProbeFolderContent,
} from '@/lib/kb/folder-content-probe';
import type { SearchResult } from '@/lib/kb/types';

describe('folder-content-probe', () => {
  it('extracts EGTS_SR_ADAS_DATA as content identifier', () => {
    const ids = extractContentIdentifiers('найди информацию по EGTS_SR_ADAS_DATA');
    expect(ids).toContain('egts_sr_adas_data');
  });

  it('scores path by identifier token overlap', () => {
    const score = scoreManifestPath(
      'Описание протокола EGTS 05_03_2026.docx',
      'EGTS_SR_ADAS_DATA',
    );
    expect(score).toBeGreaterThan(0);
  });

  it('should probe when hits lack content identifier', () => {
    const hits: SearchResult[] = [{
      id: '1',
      sourceId: 's1',
      content: 'Файл: readme.md',
      metadata: { manifest: true },
      score: 0.1,
      matchType: 'bm25',
      sourceName: 'Downloads',
      sourceType: 'folder',
    }];
    expect(shouldProbeFolderContent('EGTS_SR_ADAS_DATA', hits)).toBe(true);
  });

  it('should not probe when identifier already in hit content', () => {
    const hits: SearchResult[] = [{
      id: '1',
      sourceId: 's1',
      content: 'Service EGTS_SR_ADAS_DATA record format',
      metadata: {},
      score: 0.9,
      matchType: 'bm25',
      sourceName: 'doc',
      sourceType: 'document',
    }];
    expect(shouldProbeFolderContent('EGTS_SR_ADAS_DATA', hits)).toBe(false);
  });
});
