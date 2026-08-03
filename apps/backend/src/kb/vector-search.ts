/**
 * Vector search — KNN via sqlite-vec kb_vec_virtual.
 *
 * Per docs/ARCHITECTURE.md § 7.3 — vector search using cosine similarity
 * on chunk embeddings stored in kb_vec_virtual (vec0 virtual table).
 *
 * M4: loads all chunk embeddings from the chunks table (stored as BLOB)
 * and computes cosine similarity in JS. This is correct for small corpora;
 * M4.5+ will push KNN into the vec0 table for 100k+ chunks.
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { resources } from "../db/schema.js";
import { embedText } from "../llm/ollama.js";
import { logger } from "../util/logger.js";
import type { SearchResult, ChunkMetadata } from "@lia/shared";

interface ChunkWithEmbedding {
  id: string;
  resourceId: string;
  content: string;
  metadata: ChunkMetadata;
  embedding: Float32Array | null;
}

let vectorCache: ChunkWithEmbedding[] | null = null;

/**
 * Load all chunks with embeddings from DB.
 * Cached in-memory; invalidated on reindex.
 */
function loadVectorCorpus(): ChunkWithEmbedding[] {
  if (vectorCache) return vectorCache;

  const sqlite = getDb();

  // Note: chunks table doesn't store embedding directly — it stores vecRowid
  // pointing to kb_vec_virtual. For M4 simplicity we store embeddings in
  // a separate column added via the indexer. If that column doesn't exist,
  // we skip vector search (BM25 only).
  try {
    const rows = sqlite
      .prepare(
        `SELECT id, resource_id, content, metadata, embedding FROM chunks WHERE embedding IS NOT NULL`,
      )
      .all() as Array<{
        id: string;
        resource_id: string;
        content: string;
        metadata: string;
        embedding: Buffer;
      }>;

    vectorCache = rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      content: row.content,
      metadata: JSON.parse(row.metadata) as ChunkMetadata,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    }));
  } catch {
    // embedding column doesn't exist yet — return empty
    logger.debug("vector search: embedding column not available, returning empty");
    vectorCache = [];
  }

  return vectorCache;
}

/** Invalidate the vector cache (called after indexing). */
export function invalidateVectorCache(): void {
  vectorCache = null;
}

/**
 * Search chunks using vector similarity (cosine).
 *
 * @param query       search query (will be embedded)
 * @param resourceIds scope to specific resources
 * @param limit       max results
 * @param minSim      minimum similarity threshold (default 0.3)
 */
export async function vectorSearch(
  query: string,
  opts: { resourceIds?: string[]; limit?: number; minSim?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const minSim = opts.minSim ?? 0.3;

  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) {
    logger.warn("vector search: query embedding returned null");
    return [];
  }

  const allChunks = loadVectorCorpus();
  const scoped = opts.resourceIds
    ? allChunks.filter((c) => opts.resourceIds!.includes(c.resourceId))
    : allChunks;

  if (scoped.length === 0) return [];

  // Compute cosine similarity
  const scored: Array<{ chunk: ChunkWithEmbedding; sim: number }> = [];
  for (const chunk of scoped) {
    if (!chunk.embedding) continue;
    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (sim >= minSim) {
      scored.push({ chunk, sim });
    }
  }

  scored.sort((a, b) => b.sim - a.sim);

  // Load resource names
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const resourceIdSet = new Set(scored.map((s) => s.chunk.resourceId));
  const resourceRows = db
    .select({ id: resources.id, name: resources.name, kind: resources.kind })
    .from(resources)
    .all()
    .filter((r) => resourceIdSet.has(r.id));
  const resourceMap = new Map(resourceRows.map((r) => [r.id, r]));

  return scored.slice(0, limit).map(({ chunk, sim }) => ({
    chunkId: chunk.id,
    resourceId: chunk.resourceId,
    content: chunk.content,
    metadata: chunk.metadata,
    score: sim,
    matchType: "vector" as const,
    resourceName: resourceMap.get(chunk.resourceId)?.name ?? "",
    resourceKind: resourceMap.get(chunk.resourceId)?.kind ?? "",
  }));
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
