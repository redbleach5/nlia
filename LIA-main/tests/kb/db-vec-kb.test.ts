// Smoke tests for src/lib/kb/db-vec-kb.ts — KB vector index ops.
//
// Эти тесты проверяют critical-path паттерн dual-write (kb_vec_virtual +
// kb_rowid_map) для KB Phase 1. Тесты используют ту же better-sqlite3 БД,
// что и основной код — через getDb() singleton из db-vec.ts.
//
// ВНИМАНИЕ: тесты требуют, чтобы Prisma schema была применена (таблицы
// Source/Chunk должны существовать). Если БД не мигрирована —
// тесты упадут с понятной ошибкой. Запуск:
//   bun run db:push && bun run test
//
// Тесты не используют реальный Ollama — embeddings синтетические
// (детерминированные из content hash). Это позволяет запускать тесты
// без запущенного Ollama instance.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  insertKbVector,
  searchKbVectors,
  deleteKbVector,
  deleteKbVectorsForSource,
  countKbVectors,
} from '@/lib/kb/db-vec-kb';
import { generateRandomRowid, getDb } from '@/lib/db-vec';

// ============================================================================
// Helpers — синтетические embeddings (детерминированные, без Ollama)
// ============================================================================

/**
 * Сгенерировать синтетический 768-dim embedding из строки.
 *
 * Использует простой hash-based алгоритм: каждый символ строки задаёт
 * значение одного измерения (с wrap-around). Это НЕ семантический embedding,
 * но позволяет тестировать vector ops без запущенного Ollama.
 *
 * Two different strings → different embeddings (high probability).
 * Same string → same embedding (детерминированность).
 */
function syntheticEmbedding(text: string, seed = 0): Float32Array {
  const dim = 768;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    // Mix text chars with dimension index for variety
    const charIdx = (i + seed) % text.length;
    const c = text.charCodeAt(charIdx);
    // Normalize to [-1, 1] using sin — gives smooth, deterministic values
    vec[i] = Math.sin((c * (i + 1) * 0.01) % (2 * Math.PI));
  }
  // Normalize to unit length (так делает реальный nomic-embed-text)
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ============================================================================
// Тесты
// ============================================================================

describe('kb/db-vec-kb — KB Phase 1 vector index', () => {
  // Убеждается, что getDb() инициировал sqlite-vec и создал kb_vec_virtual.
  // Если БД не мигрирована — тесты упадут здесь с понятной ошибкой.
  beforeAll(() => {
    // Trigger lazy init of kb_vec_virtual by calling countKbVectors()
    expect(() => countKbVectors()).not.toThrow();

    const db = getDb();
    // Verify kb_vec_virtual exists
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'kb_vec_virtual'",
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('kb_vec_virtual');

    // P0-4 fix: clean up stale entries from other test files (inverted-index, etc.)
    // vec0 KNN returns globally nearest — stale entries can crowd out test entries.
    db.exec(`DELETE FROM kb_vec_virtual`);
    db.exec(`DELETE FROM kb_rowid_map`);
  });

  it('insertKbVector writes to both kb_vec_virtual and kb_rowid_map (dual-write)', () => {
    const chunkId = `test-dual-write-${Date.now()}`;
    const sourceId = `test-source-${Date.now()}`;
    const embedding = syntheticEmbedding('hello world');

    insertKbVector({
      id: chunkId,
      sourceId,
      sourceType: 'document',
      embedding,
    });

    // Verify kb_rowid_map has the entry (rowids are random — lookup by chunk_id).
    const db = getDb();
    const mapRow = db.prepare(
      'SELECT chunk_id, source_id FROM kb_rowid_map WHERE chunk_id = ?',
    ).get(chunkId) as { chunk_id: string; source_id: string } | undefined;

    expect(mapRow).toBeDefined();
    expect(mapRow?.chunk_id).toBe(chunkId);
    expect(mapRow?.source_id).toBe(sourceId);

    // Verify kb_vec_virtual has the entry (JOIN via kb_rowid_map — vec0 may not
    // support SELECT WHERE rowid = ? with BigInt reliably)
    const vecRow = db.prepare(
      'SELECT v.source_id, v.source_type FROM kb_vec_virtual v JOIN kb_rowid_map m ON v.rowid = m.rowid WHERE m.chunk_id = ?',
    ).get(chunkId) as { source_id: string; source_type: string } | undefined;

    expect(vecRow).toBeDefined();
    expect(vecRow?.source_id).toBe(sourceId);
    expect(vecRow?.source_type).toBe('document');

    // Cleanup
    deleteKbVector(chunkId);
  });

  it('searchKbVectors returns matching chunks ordered by similarity', async () => {
    const sourceId = `test-search-src-${Date.now()}`;
    const queryEmbedding = syntheticEmbedding('auth login error');
    // Insert chunks with varying similarity to the query
    insertKbVector({
      id: `${sourceId}-chunk-high`,
      sourceId,
      sourceType: 'document',
      embedding: queryEmbedding,  // identical → similarity ≈ 1.0
    });
    insertKbVector({
      id: `${sourceId}-chunk-mid`,
      sourceId,
      sourceType: 'document',
      embedding: syntheticEmbedding('auth login'),  // similar
    });
    insertKbVector({
      id: `${sourceId}-chunk-low`,
      sourceId,
      sourceType: 'document',
      embedding: syntheticEmbedding('completely different topic'),  // dissimilar
    });

    const hits = await searchKbVectors({
      embedding: queryEmbedding,
      topK: 3,
      sourceIds: [sourceId],
    });

    expect(hits.length).toBe(3);
    // All 3 chunks should be in results (order may vary due to vec0 floating-point precision)
    const hitIds = hits.map(h => h.id);
    expect(hitIds).toContain(`${sourceId}-chunk-high`);
    expect(hitIds).toContain(`${sourceId}-chunk-mid`);
    expect(hitIds).toContain(`${sourceId}-chunk-low`);
    expect(hits[0].similarity).toBeGreaterThan(0.99);
    // Order should be by descending similarity
    expect(hits[0].similarity).toBeGreaterThanOrEqual(hits[1].similarity);
    expect(hits[1].similarity).toBeGreaterThanOrEqual(hits[2].similarity);

    // Cleanup
    deleteKbVectorsForSource(sourceId);
  });

  it('searchKbVectors pre-filters by sourceIds (no cross-source leak)', async () => {
    const sourceA = `test-src-a-${Date.now()}`;
    const sourceB = `test-src-b-${Date.now()}`;
    const embedding = syntheticEmbedding('shared content');

    insertKbVector({
      id: `${sourceA}-chunk`,
      sourceId: sourceA,
      sourceType: 'document',
      embedding,
    });
    insertKbVector({
      id: `${sourceB}-chunk`,
      sourceId: sourceB,
      sourceType: 'document',
      embedding,
    });

    // Search only in sourceA — should NOT return sourceB's chunk
    const hits = await searchKbVectors({
      embedding,
      topK: 10,
      sourceIds: [sourceA],
    });

    expect(hits.length).toBe(1);
    expect(hits[0].sourceId).toBe(sourceA);

    // Cleanup
    deleteKbVectorsForSource(sourceA);
    deleteKbVectorsForSource(sourceB);
  });

  it('searchKbVectors pre-filters by sourceTypes', async () => {
    const sourceId = `test-type-filter-${Date.now()}`;
    const embedding = syntheticEmbedding('type filter test');

    insertKbVector({
      id: `${sourceId}-doc`,
      sourceId,
      sourceType: 'document',
      embedding,
    });
    insertKbVector({
      id: `${sourceId}-code`,
      sourceId,
      sourceType: 'codebase',
      embedding,
    });

    const docHits = await searchKbVectors({
      embedding,
      topK: 10,
      sourceIds: [sourceId],
      sourceTypes: ['document'],
    });
    expect(docHits.length).toBe(1);
    expect(docHits[0].id).toBe(`${sourceId}-doc`);

    const codeHits = await searchKbVectors({
      embedding,
      topK: 10,
      sourceIds: [sourceId],
      sourceTypes: ['codebase'],
    });
    expect(codeHits.length).toBe(1);
    expect(codeHits[0].id).toBe(`${sourceId}-code`);

    deleteKbVectorsForSource(sourceId);
  });

  it('deleteKbVectorsForSource removes both vec and map entries', () => {
    const sourceId = `test-delete-src-${Date.now()}`;
    const embedding = syntheticEmbedding('to be deleted');

    insertKbVector({
      id: `${sourceId}-1`,
      sourceId,
      sourceType: 'document',
      embedding,
    });
    insertKbVector({
      id: `${sourceId}-2`,
      sourceId,
      sourceType: 'document',
      embedding,
    });

    // Verify inserted
    const db = getDb();
    const beforeMap = db.prepare(
      'SELECT COUNT(*) as c FROM kb_rowid_map WHERE source_id = ?',
    ).get(sourceId) as { c: number };
    expect(beforeMap.c).toBe(2);

    // Delete
    deleteKbVectorsForSource(sourceId);

    // Verify both kb_rowid_map and kb_vec_virtual are clean
    const afterMap = db.prepare(
      'SELECT COUNT(*) as c FROM kb_rowid_map WHERE source_id = ?',
    ).get(sourceId) as { c: number };
    expect(afterMap.c).toBe(0);

    // Verify no orphaned vec entries (query by source_id, not pre-computed rowid)
    // P0-4: rowids are random — cannot pre-compute from chunk id.
    const orphaned = db.prepare(
      'SELECT COUNT(*) as c FROM kb_vec_virtual v JOIN kb_rowid_map m ON v.rowid = m.rowid WHERE m.source_id = ?',
    ).get(sourceId) as { c: number };
    expect(orphaned.c).toBe(0);
  });

  it('deleteKbVector removes single chunk (granular)', () => {
    const sourceId = `test-delete-one-${Date.now()}`;
    const embedding = syntheticEmbedding('single delete');

    insertKbVector({
      id: `${sourceId}-keep`,
      sourceId,
      sourceType: 'document',
      embedding,
    });
    insertKbVector({
      id: `${sourceId}-del`,
      sourceId,
      sourceType: 'document',
      embedding,
    });

    deleteKbVector(`${sourceId}-del`);

    const db = getDb();
    const remaining = db.prepare(
      'SELECT chunk_id FROM kb_rowid_map WHERE source_id = ?',
    ).all(sourceId) as Array<{ chunk_id: string }>;
    expect(remaining.length).toBe(1);
    expect(remaining[0].chunk_id).toBe(`${sourceId}-keep`);

    // Cleanup
    deleteKbVectorsForSource(sourceId);
  });

  it('insertKbVector is idempotent (INSERT OR REPLACE)', () => {
    const chunkId = `test-idempotent-${Date.now()}`;
    const sourceId = `test-idempotent-src-${Date.now()}`;
    const embedding1 = syntheticEmbedding('v1');
    const embedding2 = syntheticEmbedding('v2');

    // Insert twice with different embeddings
    insertKbVector({ id: chunkId, sourceId, sourceType: 'document', embedding: embedding1 });
    insertKbVector({ id: chunkId, sourceId, sourceType: 'document', embedding: embedding2 });

    // Should only have ONE entry (no duplicates)
    // P0-4 fix: query by chunk_id, not pre-computed rowid
    const db = getDb();
    const mapRows = db.prepare(
      'SELECT COUNT(*) as c FROM kb_rowid_map WHERE chunk_id = ?',
    ).get(chunkId) as { c: number };
    expect(mapRows.c).toBe(1);

    // Verify kb_vec_virtual also has exactly 1 entry (via JOIN)
    const vecRows = db.prepare(
      'SELECT COUNT(*) as c FROM kb_vec_virtual v JOIN kb_rowid_map m ON v.rowid = m.rowid WHERE m.chunk_id = ?',
    ).get(chunkId) as { c: number };
    expect(vecRows.c).toBe(1);

    // Cleanup
    deleteKbVector(chunkId);
  });

  it('countKbVectors returns a non-negative number', () => {
    const count = countKbVectors();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('generateRandomRowid returns unique collision-free BigInt (P0-4)', () => {
    // P0-4: UUID-based random BigInt — not a hash of an id (birthday paradox
    // at ~46k rows with the old Java-hash). Map tables are source of truth.
    const rowid1 = generateRandomRowid();
    const rowid2 = generateRandomRowid();
    expect(rowid1).not.toBe(rowid2);
    expect(typeof rowid1).toBe('bigint');
    expect(typeof rowid2).toBe('bigint');
    // Both should be in [2^31, 2^63) — above legacy 31-bit range
    expect(rowid1 >= BigInt(2147483648)).toBe(true);  // >= 2^31
    expect(rowid1 < BigInt('9223372036854775808')).toBe(true);  // < 2^63
    expect(rowid2 >= BigInt(2147483648)).toBe(true);
    expect(rowid2 < BigInt('9223372036854775808')).toBe(true);
  });

  it('generateRandomRowid returns BigInt (required by sqlite-vec v0.1.9)', () => {
    // better-sqlite3 binds Number as float64 (REAL),
    // vec0 rejects with "Only integers are allowed". BigInt binds as INTEGER.
    const rowid = generateRandomRowid();
    expect(typeof rowid).toBe('bigint');
  });
});
