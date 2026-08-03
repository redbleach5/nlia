import { describe, expect, it } from 'vitest';
import { parseSourceCitationHref, formatSourceCitationMarkdown } from '@/lib/kb/citation-href';

describe('citation-href', () => {
  it('parses source-only href', () => {
    expect(parseSourceCitationHref('#source:abc123')).toEqual({ sourceId: 'abc123' });
  });

  it('parses source + chunk href', () => {
    expect(parseSourceCitationHref('#source:src1:chunk9')).toEqual({
      sourceId: 'src1',
      chunkId: 'chunk9',
    });
  });

  it('rejects empty / non-citation', () => {
    expect(parseSourceCitationHref('#source:')).toBeNull();
    expect(parseSourceCitationHref('https://example.com')).toBeNull();
  });

  it('formats markdown citation', () => {
    expect(formatSourceCitationMarkdown('Doc > Ch1', 's1', 'c1'))
      .toBe('[Doc > Ch1](#source:s1:c1)');
    expect(formatSourceCitationMarkdown('Doc', 's1'))
      .toBe('[Doc](#source:s1)');
  });
});
