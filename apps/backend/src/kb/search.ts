/**
 * Hybrid search — vector + BM25 + RRF + MMR + multi-query + HyDE.
 *
 * Per docs/ARCHITECTURE.md § 7.3.
 *
 * Pipeline:
 *   1. Vector search (cosine similarity via embeddings)
 *   2. BM25 search (tokenized + stemmed)
 *   3. RRF fusion (combine ranked lists, k=60)
 *   4. Reranker (optional, cross-encoder — M4 stub)
 *   5. MMR diversification (dedupe chunks from same file)
 *   6. Source-boost (persistent KB +0.1, inline +0.05)
 *
 * Optional advanced:
 *   - Multi-query expansion: generate 3 reformulations, search all, RRF
 *   - HyDE: generate hypothetical answer, embed, use as query
 */

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { resources } from "../db/schema.js";
import { vectorSearch } from "./vector-search.js";
import { bm25Search } from "./bm25.js";
import { rrf, mmrDiversify } from "./rrf.js";
import { rerank } from "./reranker.js";
import { buildExpandedQueries } from "./query-expansion.js";
import type { SearchResult, SearchOpts, SearchResponse } from "@lia/shared";

/**
 * Run hybrid search across KB chunks.
 *
 * @param episodeId  episode to scope resources (episode-scoped + global)
 * @param query      search query
 * @param opts       search options
 */
export async function hybridSearch(
  episodeId: string,
  query: string,
  opts: SearchOpts = {},
): Promise<SearchResponse> {
  const startedAt = Date.now();
  const limit = opts.limit ?? 10;
  const useReranker = opts.reranker ?? false;
  const useMultiQuery = opts.multiQuery ?? false;
  const useHyde = opts.hyde ?? false;
  const useMmr = opts.mmr ?? true;
  const mmrLambda = opts.mmrLambda ?? 0.7;

  // 1. Resolve scope: episode-scoped + global resources
  const resourceIds = await resolveResourceScope(episodeId, opts.resourceIds);
  if (resourceIds.length === 0) {
    return emptyResponse(query, startedAt);
  }

  // 2. Build query list (original + optional multi-query expansions + HyDE)
  const queries = await buildExpandedQueries(query, { multiQuery: useMultiQuery, hyde: useHyde });

  // 3. Run vector + BM25 for each query, collect all ranked lists
  const allLists: SearchResult[][] = [];
  for (const q of queries) {
    const [vecResults, bm25Results] = await Promise.all([
      vectorSearch(q, { resourceIds, limit: 20 }),
      Promise.resolve(bm25Search(q, { resourceIds, limit: 20 })),
    ]);
    allLists.push(vecResults, bm25Results);
  }

  // 4. RRF fusion
  let fused = rrf(allLists);

  if (fused.length === 0) {
    return {
      results: [],
      totalChunks: 0,
      durationMs: Date.now() - startedAt,
      reranked: false,
      multiQueryUsed: useMultiQuery,
      hydeUsed: useHyde,
    };
  }

  // 5. Reranker (optional)
  let reranked = false;
  if (useReranker && fused.length > 0) {
    fused = await rerank(query, fused, { topN: 20 });
    reranked = true;
  }

  // 6. Source-boost: persistent KB +0.1, inline +0.05
  fused = applySourceBoost(fused, resourceIds);

  // 7. MMR diversification
  if (useMmr) {
    fused = mmrDiversify(fused, mmrLambda, limit);
  } else {
    fused = fused.slice(0, limit);
  }

  // Count total chunks searched
  const totalChunks = countChunks(resourceIds);

  return {
    results: fused.slice(0, limit),
    totalChunks,
    durationMs: Date.now() - startedAt,
    reranked,
    multiQueryUsed: useMultiQuery,
    hydeUsed: useHyde,
  };
}

/** Resolve which resource ids to search: episode-scoped + global. */
async function resolveResourceScope(
  episodeId: string,
  explicitIds?: string[],
): Promise<string[]> {
  const sqlite = getDb();
  const db = drizzle(sqlite);

  if (explicitIds && explicitIds.length > 0) {
    return db
      .select({ id: resources.id })
      .from(resources)
      .where(inArray(resources.id, explicitIds))
      .all()
      .map((r) => r.id);
  }

  // All resources for this episode + global (episodeId IS NULL)
  const rows = sqlite
    .prepare(
      `SELECT id FROM resources WHERE episode_id = ? OR episode_id IS NULL`,
    )
    .all(episodeId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Build query list: delegates to query-expansion module (real LLM multi-query + HyDE).
 */
/** Apply source-boost: persistent KB +0.1, inline +0.05. */
function applySourceBoost(results: SearchResult[], _resourceIds: string[]): SearchResult[] {
  const sqlite = getDb();
  // Build resource kind map
  const rows = sqlite
    .prepare(`SELECT id, kind, episode_id FROM resources`)
    .all() as Array<{ id: string; kind: string; episode_id: string | null }>;
  const kindMap = new Map(rows.map((r) => [r.id, { kind: r.kind, global: r.episode_id === null }]));

  return results.map((r) => {
    const info = kindMap.get(r.resourceId);
    let boost = 0;
    if (info?.global) boost = 0.1; // persistent KB source
    else if (info?.kind === "inline") boost = 0.05; // chat attachment
    return { ...r, score: r.score + boost };
  });
}

/** Count total chunks for the searched resources. */
function countChunks(resourceIds: string[]): number {
  if (resourceIds.length === 0) return 0;
  const sqlite = getDb();
  const placeholders = resourceIds.map(() => "?").join(",");
  const row = sqlite
    .prepare(`SELECT COUNT(*) as c FROM chunks WHERE resource_id IN (${placeholders})`)
    .get(...resourceIds) as { c: number };
  return row.c;
}

function emptyResponse(_query: string, startedAt: number): SearchResponse {
  return {
    results: [],
    totalChunks: 0,
    durationMs: Date.now() - startedAt,
    reranked: false,
    multiQueryUsed: false,
    hydeUsed: false,
  };
}
