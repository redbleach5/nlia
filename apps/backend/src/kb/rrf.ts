/**
 * Reciprocal Rank Fusion (RRF) — combine ranked lists.
 *
 * Ported from v2 src/lib/kb/rrf.ts.
 * Per docs/ARCHITECTURE.md § 7.3.
 *
 * For each item: sum 1/(k + rank) across all lists.
 * k = 60 — standard value balancing early vs late ranks.
 *
 * Advantages:
 *   - No score normalization needed (BM25 and cosine sim have different scales)
 *   - Robust to outliers
 *   - Simple: ~20 lines
 */

import type { SearchResult } from "@lia/shared";

export function rrf(lists: SearchResult[][], k = 60): SearchResult[] {
  const scores = new Map<string, { score: number; item: SearchResult }>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      const existing = scores.get(item.chunkId);
      const contribution = 1 / (k + rank + 1);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(item.chunkId, { score: contribution, item });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((s) => ({
      ...s.item,
      score: s.score,
      matchType: "fused" as const,
    }));
}

/**
 * MMR (Maximal Marginal Relevance) diversification.
 *
 * Per docs/ARCHITECTURE.md § 7.3 — if 3 chunks from same file, keep 1 best.
 * Iteratively select results that balance relevance + diversity.
 *
 * @param results  ranked search results
 * @param lambda   0 = all diverse, 1 = all relevant (default 0.7)
 * @param limit    max results to return
 */
export function mmrDiversify(
  results: SearchResult[],
  lambda = 0.7,
  limit?: number,
): SearchResult[] {
  if (results.length <= 1) return results;
  const maxResults = limit ?? results.length;

  const selected: SearchResult[] = [results[0]!];
  const remaining = results.slice(1);

  while (remaining.length > 0 && selected.length < maxResults) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      // Relevance score (normalized)
      const relevance = candidate.score;

      // Diversity: max similarity to any already-selected result
      // Similarity = 1 if same resource+file, else 0 (simplified; M6 will use embedding cosine)
      let maxSim = 0;
      for (const sel of selected) {
        const sameResource = candidate.resourceId === sel.resourceId;
        const sameFile =
          candidate.metadata.filePath === sel.metadata.filePath &&
          candidate.metadata.filePath !== undefined;
        if (sameResource && sameFile) {
          maxSim = Math.max(maxSim, 1);
        } else if (sameResource) {
          maxSim = Math.max(maxSim, 0.5);
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
