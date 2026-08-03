import 'server-only';

/**
 * Select the most relevant chunks for a focus query (agent get_source / synthesis).
 * Prefer full content of a few matching chunks + neighbors over head-truncating
 * an entire document (which drops late sections like EGTS_SR_ADAS_DATA).
 */

const STOP = new Set([
  'найди', 'найти', 'опиши', 'расскажи', 'подробнее', 'база', 'знаний', 'базе',
  'документ', 'документе', 'протокол', 'что', 'это', 'за', 'про', 'только',
  'факты', 'без', 'выдумок', 'затем', 'ответь', 'используй', 'query',
  'the', 'and', 'for', 'with', 'from',
]);

export function extractFocusKeywords(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    out.add(m[0].toLowerCase());
  }
  for (const m of query.matchAll(/\b\d{2,}\b/g)) {
    out.add(m[0]);
  }
  for (const m of query.toLowerCase().matchAll(/[a-zа-яё]{4,}/giu)) {
    const t = m[0].toLowerCase();
    if (!STOP.has(t)) out.add(t);
  }
  return [...out];
}

export function scoreTextAgainstKeywords(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const k of keywords) {
    if (lower.includes(k)) hits += 1;
  }
  return hits / keywords.length;
}

export type FocusableChunk = {
  content: string;
  position: number;
};

/**
 * Rank chunks by focusQuery; keep top hits + ±neighborRadius by position.
 * Returns chunks sorted by position for readable synthesis.
 */
export function selectChunksByFocusQuery<T extends FocusableChunk>(
  chunks: T[],
  focusQuery: string | undefined,
  opts: { maxChunks?: number; neighborRadius?: number; minScore?: number } = {},
): { selected: T[]; mode: 'full' | 'focused'; dropped: number } {
  const maxChunks = opts.maxChunks ?? 16;
  const neighborRadius = opts.neighborRadius ?? 1;
  const minScore = opts.minScore ?? 0.08;

  if (!focusQuery?.trim() || chunks.length <= maxChunks) {
    return { selected: chunks, mode: 'full', dropped: 0 };
  }

  const keywords = extractFocusKeywords(focusQuery);
  if (keywords.length === 0) {
    return { selected: chunks.slice(0, maxChunks), mode: 'focused', dropped: Math.max(0, chunks.length - maxChunks) };
  }

  const scored = chunks
    .map((c, idx) => ({ c, idx, score: scoreTextAgainstKeywords(c.content, keywords) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || a.c.position - b.c.position);

  if (scored.length === 0) {
    // No lexical hits — keep middle/end bias avoided; return first maxChunks as fallback.
    return {
      selected: chunks.slice(0, maxChunks),
      mode: 'focused',
      dropped: Math.max(0, chunks.length - maxChunks),
    };
  }

  const keepIdx = new Set<number>();
  for (const hit of scored.slice(0, Math.max(4, Math.floor(maxChunks / 2)))) {
    for (let d = -neighborRadius; d <= neighborRadius; d++) {
      const j = hit.idx + d;
      if (j >= 0 && j < chunks.length) keepIdx.add(j);
    }
  }

  // Fill remaining budget with next-best scored chunks.
  for (const hit of scored) {
    if (keepIdx.size >= maxChunks) break;
    keepIdx.add(hit.idx);
  }

  const selected = [...keepIdx]
    .sort((a, b) => a - b)
    .slice(0, maxChunks)
    .map((i) => chunks[i]);

  return {
    selected,
    mode: 'focused',
    dropped: Math.max(0, chunks.length - selected.length),
  };
}
