import 'server-only';

// ============================================================================
// isRepeatedMessage — Jaccard similarity on normalized words (threshold 0.8).
// ============================================================================
//
// Cheap heuristic for near-duplicate user turns. Not wired into the chat
// pipeline today; kept for tests / future UX. Prefer this over embedding
// similarity (no extra Ollama round-trip).

const SIMILARITY_THRESHOLD = 0.8;

export function isRepeatedMessage(current: string, previous: string): boolean {
  if (!current || !previous) return false;
  if (current.length < 10 || previous.length < 10) return false;

  const currentWords = normalizeToWords(current);
  const previousWords = normalizeToWords(previous);

  if (currentWords.size === 0 || previousWords.size === 0) return false;

  const similarity = jaccardSimilarity(currentWords, previousWords);
  return similarity >= SIMILARITY_THRESHOLD;
}

function normalizeToWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
