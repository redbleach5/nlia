/**
 * KB search types — shared between backend (search service) and frontend.
 *
 * Per docs/ARCHITECTURE.md § 7.3 — hybrid search with RRF + reranker + MMR.
 */

export interface ChunkMetadata {
  heading?: string;
  path?: string;
  sectionIndex?: number;
  charStart?: number;
  charEnd?: number;
  mimeType?: string;
  filePath?: string;
}

export interface Chunk {
  id: string;
  resourceId: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
  parentId: string | null;
  position: number;
  indexedAt: number;
}

export type MatchType = "vector" | "bm25" | "fused" | "reranked";

export interface SearchResult {
  chunkId: string;
  resourceId: string;
  content: string;
  metadata: ChunkMetadata;
  /** Similarity/score from search (0..1 for vector, arbitrary for BM25/RRF). */
  score: number;
  matchType: MatchType;
  resourceName: string;
  resourceKind: string;
}

export interface SearchOpts {
  /** Limit number of results (default 10). */
  limit?: number;
  /** Scope to specific resource ids. */
  resourceIds?: string[];
  /** Enable cross-encoder reranker (default false — opt-in per § 13.6). */
  reranker?: boolean;
  /** Enable multi-query expansion (generates 3 reformulations). */
  multiQuery?: boolean;
  /** Enable HyDE (Hypothetical Document Embedding). */
  hyde?: boolean;
  /** Enable MMR diversification (default true). */
  mmr?: boolean;
  /** MMR lambda (0=all diverse, 1=all relevant; default 0.7). */
  mmrLambda?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Total chunks searched. */
  totalChunks: number;
  /** Time taken in ms. */
  durationMs: number;
  /** Whether reranker was applied. */
  reranked: boolean;
  /** Whether multi-query expansion was used. */
  multiQueryUsed: boolean;
  /** Whether HyDE was used. */
  hydeUsed: boolean;
}

export interface IndexProgress {
  resourceId: string;
  phase: "collecting" | "parsing" | "chunking" | "embedding" | "done" | "error";
  processed: number;
  total: number;
  percent: number;
  errorMessage?: string;
}
