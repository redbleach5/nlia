import { describe, expect, it } from 'vitest';
import { extractKbQueryKeywords, filterKbHitsForQuery, formatKbHitForPrompt, kbHitsContainIdentifier, withSoftKbHitFallback } from '@/lib/kb/kb-query-filter';
import type { SearchResult } from '@/lib/kb/types';

function mockHit(content: string, citation?: string): SearchResult {
  return {
    id: '1',
    sourceId: 's1',
    content,
    metadata: {},
    score: 0.5,
    matchType: 'fused',
    citation,
    sourceName: 'Test',
    sourceType: 'document',
  };
}

describe('extractKbQueryKeywords', () => {
  it('extracts EGTS identifier', () => {
    const kw = extractKbQueryKeywords('найди информацию в папке по EGTS_SR_ADAS_DATA');
    expect(kw).toContain('egts_sr_adas_data');
    expect(kw).toContain('egts');
  });

  it('extracts Cyrillic acronyms (СМСВ)', () => {
    const kw = extractKbQueryKeywords('интересует СМСВ');
    expect(kw).toContain('смсв');
    expect(kw).not.toContain('интересует');
  });
});

describe('filterKbHitsForQuery', () => {
  it('drops irrelevant README hits when query has EGTS token', () => {
    const hits = [
      mockHit('Next.js 16 App Router', 'README > Стек'),
      mockHit('EGTS_SR_ADAS_DATA service record format', 'EGTS > ADAS'),
    ];
    const { hits: filtered, strictFilterApplied } = filterKbHitsForQuery(
      hits,
      'найди EGTS_SR_ADAS_DATA',
    );
    expect(strictFilterApplied).toBe(true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].content).toContain('EGTS_SR_ADAS_DATA');
  });

  it('returns empty when no hit matches strong identifiers', () => {
    const hits = [mockHit('Next.js stack', 'README')];
    const { hits: filtered } = filterKbHitsForQuery(hits, 'EGTS_SR_ADAS_DATA');
    expect(filtered).toHaveLength(0);
  });

  it('keeps hits matching Cyrillic acronym', () => {
    const hits = [
      mockHit('Next.js stack', 'README'),
      mockHit('Поле СМСВ содержит статус модема', 'EGTS > SMS'),
    ];
    const { hits: filtered, strictFilterApplied } = filterKbHitsForQuery(hits, 'интересует СМСВ');
    expect(strictFilterApplied).toBe(true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].content).toContain('СМСВ');
  });
});

describe('withSoftKbHitFallback', () => {
  it('returns raw top hits when filtered empty', () => {
    const raw = [mockHit('a'), mockHit('b'), mockHit('c'), mockHit('d')];
    raw[0].score = 0.2;
    raw[1].score = 0.9;
    const { hits, usedSoftFallback } = withSoftKbHitFallback([], raw, 2);
    expect(usedSoftFallback).toBe(true);
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBe(0.9);
  });

  it('keeps filtered hits when present', () => {
    const filtered = [mockHit('exact')];
    const { hits, usedSoftFallback } = withSoftKbHitFallback(filtered, [mockHit('other')], 3);
    expect(usedSoftFallback).toBe(false);
    expect(hits).toEqual(filtered);
  });
});

describe('formatKbHitForPrompt', () => {
  it('centers excerpt on identifier, not start of document', () => {
    const padding = 'x'.repeat(5000);
    const content = `${padding}EGTS_SR_ADAS_DATA service record${'y'.repeat(5000)}`;
    const excerpt = formatKbHitForPrompt(content, 'EGTS_SR_ADAS_DATA', 800);
    expect(excerpt).toContain('EGTS_SR_ADAS_DATA');
    expect(excerpt).not.toMatch(/^x{100}/);
  });
});

describe('kbHitsContainIdentifier', () => {
  it('detects identifier in hits', () => {
    expect(kbHitsContainIdentifier('EGTS_SR_ADAS_DATA', [
      { content: 'field EGTS_SR_ADAS_DATA format' },
    ])).toBe(true);
  });
});
