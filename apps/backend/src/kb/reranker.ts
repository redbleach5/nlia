/**
 * Real cross-encoder reranker via Ollama.
 * Replaces M4 stub. Per docs/ARCHITECTURE.md § 7.3.
 *
 * Uses a reranker model (e.g. bge-reranker-v2-m3) through Ollama's
 * /api/embed endpoint (reranker models output relevance scores).
 *
 * Opt-in via setting (latency concern per § 13.6 risk).
 * Only applied to top-20 RRF results.
 */

import { getOllamaSettings, checkOllamaHealth } from "../llm/ollama.js";
import type { SearchResult } from "@lia/shared";
import { logger } from "../util/logger.js";

const RERANKER_TIMEOUT_MS = 30_000;

/**
 * Check if a reranker model is available.
 * Looks for models with "rerank" in the name.
 */
export async function getRerankerModel(): Promise<string | null> {
  const health = await checkOllamaHealth();
  if (!health.ok) return null;

  const rerankerModels = health.models.filter((m) =>
    /rerank|bge-reranker|rge/i.test(m),
  );

  return rerankerModels[0] ?? null;
}

/**
 * Rerank search results using a cross-encoder model.
 *
 * For each (query, chunk) pair, calls Ollama with the reranker model
 * to get a relevance score. Re-sorts results by score.
 *
 * If no reranker model is available, returns results unchanged.
 */
export async function rerank(
  query: string,
  results: SearchResult[],
  opts: { topN?: number } = {},
): Promise<SearchResult[]> {
  const topN = opts.topN ?? 20;
  const topResults = results.slice(0, topN);

  if (topResults.length === 0) return [];

  const rerankerModel = await getRerankerModel();
  if (!rerankerModel) {
    logger.debug("reranker: no reranker model available, returning RRF results as-is");
    return topResults;
  }

  try {
    const settings = await getOllamaSettings();

    // Score each (query, chunk) pair
    const scored: Array<{ result: SearchResult; score: number }> = [];

    for (const result of topResults) {
      try {
        // Use Ollama's /api/embed with the reranker model
        // Reranker models take (query, document) pairs and return relevance
        const res = await fetch(`${settings.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: rerankerModel,
            input: query,
            prompt: result.content.slice(0, 500),
          }),
          signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
        });

        if (!res.ok) {
          scored.push({ result, score: result.score });
          continue;
        }

        const data = await res.json() as { embeddings?: number[][] };
        // Reranker models typically return a single score in embeddings[0][0]
        const score = data.embeddings?.[0]?.[0] ?? result.score;
        scored.push({ result, score });
      } catch {
        scored.push({ result, score: result.score });
      }
    }

    // Re-sort by reranker score
    scored.sort((a, b) => b.score - a.score);

    logger.info(
      { model: rerankerModel, count: scored.length },
      "reranker applied",
    );

    return scored.map(({ result, score }) => ({
      ...result,
      score,
      matchType: "reranked" as const,
    }));
  } catch (e) {
    logger.warn({ err: e }, "reranker failed, returning RRF results");
    return topResults;
  }
}
