/**
 * Vector memory — semantic search with episode + sourceType pre-filter.
 *
 * Ported from v2 src/lib/memory/vector.ts (adapted for Drizzle + sqlite-vec).
 * Per docs/ARCHITECTURE.md § 10.3.
 *
 * Architecture:
 *   - vectorMemory table: stores text + embedding (BLOB) + episodeId + sourceType
 *   - kb_vec_virtual: sqlite-vec KNN index on the embedding
 *   - recall() does KNN search filtered by episodeId + sourceType at SQL level
 *
 * Source types: 'dialogue' | 'fact' | 'summary' | 'emotional'
 *   - Chat recall: dialogue + fact + summary
 *   - Emotional recall: emotional
 *
 * Episode isolation: every query is scoped to episodeId — no cross-episode leaks.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { vectorMemory } from "../db/schema.js";
import { embedText } from "../llm/ollama.js";
import { logger } from "../util/logger.js";

export type VectorSourceType = "dialogue" | "fact" | "summary" | "emotional";

export interface VectorHit {
  sourceType: string;
  text: string;
  similarity: number;
}

function makeId(): string {
  return `vm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Store a memory: embed the text + insert into vectorMemory table.
 * Non-throwing — logs and returns on failure (memory is best-effort).
 */
export async function remember(params: {
  episodeId: string;
  sourceType: Exclude<VectorSourceType, "emotional">;
  text: string;
}): Promise<void> {
  try {
    const embedding = await embedText(params.text);
    if (!embedding) {
      logger.warn(
        { episodeId: params.episodeId, sourceType: params.sourceType },
        "remember: embedding returned null, skipping",
      );
      return;
    }

    const sqlite = getDb();
    const db = drizzle(sqlite);
    const id = makeId();
    const now = Math.floor(Date.now() / 1000);

    db.insert(vectorMemory)
      .values({
        id,
        episodeId: params.episodeId,
        sourceType: params.sourceType,
        text: params.text,
        embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        createdAt: now,
      })
      .run();

    logger.debug(
      { episodeId: params.episodeId, sourceType: params.sourceType, id },
      "memory stored",
    );
  } catch (e) {
    logger.warn({ err: e, episodeId: params.episodeId }, "remember failed (non-fatal)");
  }
}

/**
 * Recall relevant memories via KNN search.
 * Filters by episodeId + sourceTypes at SQL level — no cross-episode leaks.
 *
 * Returns top-N hits sorted by similarity (descending).
 */
export async function recall(params: {
  episodeId: string;
  query: string;
  limit?: number;
  minSimilarity?: number;
  sourceTypes?: Array<"dialogue" | "fact" | "summary">;
}): Promise<VectorHit[]> {
  const limit = params.limit ?? 5;
  const minSimilarity = params.minSimilarity ?? 0.3;
  const sourceTypes = params.sourceTypes ?? ["dialogue", "fact", "summary"];

  try {
    const queryEmbedding = await embedText(params.query);
    if (!queryEmbedding) {
      logger.warn({ episodeId: params.episodeId }, "recall: query embedding returned null");
      return [];
    }

    const sqlite = getDb();
    const db = drizzle(sqlite);

    // Fetch candidate rows matching episodeId + sourceTypes (pre-filter)
    const candidates = db
      .select()
      .from(vectorMemory)
      .where(eq(vectorMemory.episodeId, params.episodeId))
      .all()
      .filter((r) => sourceTypes.includes(r.sourceType as "dialogue" | "fact" | "summary"));

    if (candidates.length === 0) return [];

    // Compute cosine similarity in JS (M3 approach — simple, correct for small N)
    // M4 will optimize by pushing KNN into kb_vec_virtual vec0 table for large corpora.
    const hits: VectorHit[] = [];
    for (const row of candidates) {
      const embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const sim = cosineSimilarity(queryEmbedding, embedding);
      if (sim >= minSimilarity) {
        hits.push({
          sourceType: row.sourceType,
          text: row.text,
          similarity: sim,
        });
      }
    }

    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  } catch (e) {
    logger.warn({ err: e, episodeId: params.episodeId }, "recall failed (non-fatal)");
    return [];
  }
}

/**
 * Format vector hits for system prompt injection.
 */
export function formatVectorHitsForPrompt(hits: VectorHit[]): string {
  if (hits.length === 0) return "";
  return hits
    .map((h) => `[${h.sourceType}, sim=${h.similarity.toFixed(2)}]\n${h.text.slice(0, 500)}`)
    .join("\n---\n");
}

// ─── Cosine similarity ────────────────────────────────────────────────
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
  if (denom === 0) return 0;
  return dot / denom;
}

/** Count vector memories for an episode (for UI/debug). */
export function countVectorMemories(episodeId: string): number {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select({ id: vectorMemory.id })
    .from(vectorMemory)
    .where(eq(vectorMemory.episodeId, episodeId))
    .all();
  return rows.length;
}
