import 'server-only';

// ============================================================================
// Knowledge Base vector index — kb_vec_virtual + dual-write pattern.
// ============================================================================
//
// Это зеркальная копия паттерна из src/lib/db-vec.ts, но для KB:
//   - Prisma Chunk table хранит текст + metadata + contentHash
//   - kb_vec_virtual (vec0 virtual table) — отдельный индекс с embedding
//   - kb_rowid_map — mapping rowid (BigInt hash of chunk id) → chunk_id (UUID string)
//
// В отличие от VectorMemory (где embedding дублирован в Prisma Bytes-колонке),
// KB НЕ хранит embedding в Chunk — только в kb_vec_virtual. Это экономит
// ~3KB на чанк при 10000+ chunks (nomic-embed-text = 768-dim float32).
//
// CRITICAL: переиспользуем getDb() singleton из db-vec.ts, НЕ открываем второй
// Database instance. Открывать второй better-sqlite3 на том же файле в WAL mode
// приводит к lock errors и потерянным транзакциям.
//
// Инициализация lazy: kb_vec_virtual + kb_rowid_map создаются при первом
// вызове getDbForKb(). Это позволяет `next build` работать без БД (как и
// в db-vec.ts).

import type Database from 'better-sqlite3';
import { getDb, generateRandomRowid } from '@/lib/db-vec';
import { logger } from '@/lib/logger';
import type { SourceType, VectorSearchHit } from './types';

// ============================================================================
// Lazy init — kb_vec_virtual + kb_rowid_map создаются на первом вызове
// ============================================================================

// Schema version для raw SQL таблиц. Bump при изменении:
//   - размерности embedding (768 → 1024 при смене embed model)
//   - структуры kb_vec_virtual (новые partition columns)
//   - структуры kb_rowid_map (новые колонки)
// При несовпадении stored version и KB_VEC_SCHEMA_VERSION — автоматически
// DROP + CREATE + помечаем все sources для reindex (caller должен вызвать).
// vec0 virtual tables не поддерживают ALTER — миграция = DROP + reindex.
export const KB_VEC_SCHEMA_VERSION = 1;

let _kbInitialized = false;

/**
 * Возвращает better-sqlite3 Database singleton с загруженной sqlite-vec
 * и созданной kb_vec_virtual table.
 *
 * Reuse'ит getDb() из db-vec.ts — НЕ открывает второй Database.
 *
 * Idempotent: повторные вызовы пропускают CREATE TABLE.
 *
 * Schema versioning: если stored version != KB_VEC_SCHEMA_VERSION —
 * автоматически DROP'ает старые таблицы и создаёт новые. Caller должен
 * после этого переиндексировать все sources (см. auto-reindex в server-startup).
 */
function getDbForKb(): Database.Database {
  // getDb() из db-vec.ts уже загрузил sqlite-vec extension, проверил Prisma
  // таблицы и создал vec_virtual + vec_rowid_map. Мы добавляем kb_vec_virtual
  // рядом — в той же БД, в той же транзакции.
  const db = getDb();

  if (_kbInitialized) return db;
  _kbInitialized = true;

  try {
    // Schema versioning table (используется и для kb_vec_virtual, и для
    // kb_inverted_index — все raw SQL таблицы версионруются здесь)
    db.exec(`
      CREATE TABLE IF NOT EXISTS kb_schema_version (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Check current stored version для kb_vec_virtual
    const versionRow = db.prepare(
      `SELECT version FROM kb_schema_version WHERE name = 'kb_vec_virtual'`,
    ).get() as { version: number } | undefined;

    const storedVersion = versionRow?.version ?? 0;

    if (storedVersion > 0 && storedVersion < KB_VEC_SCHEMA_VERSION) {
      // Migration needed — DROP old tables
      logger.warn('db', `kb_vec_virtual schema v${storedVersion} → v${KB_VEC_SCHEMA_VERSION}: dropping old tables (reindex required)`);
      db.exec(`DROP TABLE IF EXISTS kb_vec_virtual`);
      db.exec(`DROP TABLE IF EXISTS kb_rowid_map`);
      // Caller (auto-reindex в server-startup) должен переиндексировать sources
    }

    // Create kb_vec_virtual — 768-dim float vectors (nomic-embed-text dimension)
    // partition columns: source_id, source_type — для pre-filter на SQL уровне.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec_virtual USING vec0(
        embedding float[768],
        source_id text,
        source_type text
      )
    `);

    // Mapping table: vec0 rowid (BigInt hash) → chunk_id (UUID string) + source_id
    // Создаётся сразу, чтобы search не падал с "no such table" на первом вызове
    // (до того, как был вызван insertKbVector ни разу).
    db.exec(`
      CREATE TABLE IF NOT EXISTS kb_rowid_map (
        rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        source_id TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_kb_rowid_map_source ON kb_rowid_map(source_id)`);

    // Update stored version
    const now = Date.now();
    db.prepare(`
      INSERT INTO kb_schema_version (name, version, updated_at)
      VALUES ('kb_vec_virtual', ?, ?)
      ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
    `).run(KB_VEC_SCHEMA_VERSION, now);

    logger.info('db', 'kb_vec_virtual + kb_rowid_map ready', { version: KB_VEC_SCHEMA_VERSION });
  } catch (e) {
    _kbInitialized = false;  // allow retry on next call
    logger.error('db', 'Failed to create KB vec tables', {}, e);
    throw e;
  }

  return db;
}

// ============================================================================
// Insert — dual-write (kb_vec_virtual + kb_rowid_map) в одной транзакции
// ============================================================================

/**
 * Вставить embedding чанка в kb_vec_virtual + mapping в kb_rowid_map.
 *
 * Атомарно: обе записи в одной better-sqlite3 транзакции. Если любая падает —
 * откатываются обе. Это предотвращает orphaned kb_rowid_map rows (которые
 * ссылаются на несуществующий vec0 rowid) и наоборот.
 *
 * Idempotent: повторная вставка с тем же chunkId перезаписывает (используется
 * при reindex). sqlite-vec v0.1.9 не поддерживает `INSERT OR REPLACE` на
 * vec0 virtual tables (бросает `UNIQUE constraint failed on primary key`),
 * поэтому используем явный `DELETE` + `INSERT` в одной транзакции.
 *
 * Caller ОБЯЗАН также записать сам Chunk (content, metadata) в Prisma —
 * это делается в indexer.ts (Phase 2) в отдельной транзакции. Можно
 * объединить в одну транзакцию с Prisma через db.$transaction, но
 * better-sqlite3 и Prisma могут конфликтовать на WAL — поэтому раздельно.
 *
 * @param params.id          chunk UUID (он же — Prisma Chunk.id)
 * @param params.sourceId    Source.id (для pre-filter и cascade delete)
 * @param params.sourceType  document | folder | url | codebase
 * @param params.embedding   768-dim float32 (nomic-embed-text)
 */
export function insertKbVector(params: {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  embedding: Float32Array;
}): void {
  const db = getDbForKb();
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;
  const rowid = generateRandomRowid();

  const txn = db.transaction(() => {
    // 0. Delete existing entries for this chunk_id (idempotent re-insert).
    //    Rowids are random (P0-4); kb_rowid_map is the source of truth.
    //    vec0 doesn't support DELETE with subquery — SELECT rowids first.
    const oldRowids = db.prepare(
      'SELECT rowid FROM kb_rowid_map WHERE chunk_id = ?',
    ).all(params.id) as Array<{ rowid: bigint | number }>;
    for (const r of oldRowids) {
      db.prepare(`DELETE FROM kb_vec_virtual WHERE rowid = ?`).run(r.rowid);
    }
    db.prepare(`DELETE FROM kb_rowid_map WHERE chunk_id = ?`).run(params.id);

    // 1. Insert into kb_vec_virtual index
    db.prepare(`
      INSERT INTO kb_vec_virtual (rowid, embedding, source_id, source_type)
      VALUES (?, vec_f32(?), ?, ?)
    `).run(rowid, embeddingStr, params.sourceId, params.sourceType);

    // 2. Store mapping rowid → chunk_id (для JOIN при search)
    db.prepare(`INSERT INTO kb_rowid_map (rowid, chunk_id, source_id) VALUES (?, ?, ?)`)
      .run(rowid, params.id, params.sourceId);
  });

  txn();
}

// ============================================================================
// Search — KNN с pre-filter по source_id / source_type
// ============================================================================

/**
 * Семантический поиск по kb_vec_virtual с pre-filter.
 *
 * Аналог searchVectorsInEpisode из db-vec.ts, но фильтрует по source_id /
 * source_type вместо episode_id.
 *
 * Возвращает только id + sourceId + similarity. Для получения content /
 * metadata caller должен сделать JOIN с Prisma Chunk table (см. search.ts
 * в Phase 2 — enrichWithSourceInfo).
 *
 * **Implementation note on KNN + partition filter:**
 * sqlite-vec v0.1.9 vec0 computes KNN globally (top-K nearest vectors in the
 * whole table) BEFORE applying WHERE filters like `m.source_id IN (...)`.
 * If the user has 100 sources with 100 chunks each (10000 total), and asks
 * for top-3 in source X — vec0 returns the 3 globally nearest vectors, then
 * filters by source_id. If none of those 3 happen to be from source X —
 * the caller gets 0 hits even though source X has relevant chunks.
 *
 * Mitigation: we over-fetch (topK * 4, capped at 200) internally, then
 * filter and trim to the requested topK in JS. For very large KBs
 * (10k+ chunks per source) this becomes inefficient — at that point a
 * separate vec0 table per source would be needed.
 *
 * @returns Promise для API-consistency с будущими async реализациями
 *          (например, если перейдём на worker thread для больших KNN).
 *          Сами операции — synchronous (better-sqlite3 sync API).
 *
 * Error handling: при любой ошибке возвращает [] (как и searchVectorsInEpisode).
 * Это позволяет searchKB (Phase 2) graceful деградировать до BM25-only.
 */
export function searchKbVectors(params: {
  embedding: Float32Array;
  topK: number;
  sourceTypes?: SourceType[];
  sourceIds?: string[];
}): Promise<VectorSearchHit[]> {
  const db = getDbForKb();
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;

  // Over-fetch to mitigate KNN + partition filter limitation (see JSDoc).
  // Cap at 200 to bound memory and latency on very large KBs.
  const fetchK = Math.min(Math.max(params.topK * 4, params.topK), 200);

  // Build WHERE clause for pre-filter.
  // vec0 требует, чтобы MATCH шёл последним в WHERE — см. sqlite-vec docs.
  let whereClause = '1=1';
  const args: Array<string | number | string> = [];

  if (params.sourceIds && params.sourceIds.length > 0) {
    const placeholders = params.sourceIds.map(() => '?').join(',');
    whereClause += ` AND m.source_id IN (${placeholders})`;
    args.push(...params.sourceIds);
  }

  if (params.sourceTypes && params.sourceTypes.length > 0) {
    const placeholders = params.sourceTypes.map(() => '?').join(',');
    whereClause += ` AND v.source_type IN (${placeholders})`;
    args.push(...params.sourceTypes);
  }

  // K и distance limit — добавляем в bind params
  // distance <= 100.0 — практический "no filter". sqlite-vec v0.1.9 vec0
  // возвращает squared distance (не сам cosine distance) — для unit vectors
  // squared cosine ∈ [0, 4]. 100.0 = гарантированно пропускает все.
  // LIMIT K всё равно обрежет до fetchK.
  // minSimilarity post-filter (если нужен) — в search.ts (Phase 2).
  args.push(embeddingStr);
  args.push(fetchK);
  args.push(100.0);  // max squared cosine distance (практически no filter)

  try {
    const rows = db.prepare(`
      SELECT v.rowid, v.distance, m.chunk_id, m.source_id
      FROM kb_vec_virtual v
      JOIN kb_rowid_map m ON v.rowid = m.rowid
      WHERE ${whereClause}
        AND v.embedding MATCH vec_f32(?)
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance
    `).all(...args) as Array<{
      chunk_id: string;
      source_id: string;
      distance: number;
    }>;

    return Promise.resolve(
      rows
        .map(r => ({
          id: r.chunk_id,
          sourceId: r.source_id,
          // sqlite-vec v0.1.9 vec0 возвращает squared cosine distance.
          // similarity = 1 - sqrt(distance) для unit vectors.
          // Если distance > 1 (squared > 1, т.е. cosine < 0) — similarity уходит в
          // отрицательный диапазон, что нормально для orthogonal/opposite vectors.
          similarity: 1 - Math.sqrt(r.distance),
        }))
        // Trim to requested topK (we over-fetched fetchK to mitigate KNN +
        // partition filter limitation — see JSDoc above).
        .slice(0, params.topK),
    );
  } catch (e) {
    logger.warn('db', 'kb_vec_virtual search failed (non-fatal)', {
      topK: params.topK,
      sourceTypes: params.sourceTypes,
      sourceIdsCount: params.sourceIds?.length ?? 0,
    }, e);
    return Promise.resolve([]);
  }
}

// ============================================================================
// Delete — для reindex и удаления source
// ============================================================================

/**
 * Удалить все векторы source из kb_vec_virtual + kb_rowid_map.
 *
 * Атомарно: обе DELETE в одной транзакции.
 *
 * Используется:
 *   - indexer.ts (Phase 2) перед реиндексацией source
 *   - API DELETE /api/kb/sources/[id] — cascade delete KB vectors
 *
 * Prisma Chunk rows удаляются отдельно через Prisma (cascade on Source delete).
 *
 * ВАЖНО: бросает ошибки наверх (НЕ проглатывает). Раньше тут был silent
 * try/catch с пометкой (non-fatal) — это приводило к кумулятивным ghost
 * vectors после неудачных удалений source. Caller обязан сам решать что
 * делать при ошибке: откатывать Prisma-операцию или ретраить.
 */
export function deleteKbVectorsForSource(sourceId: string): void {
  const db = getDbForKb();

  const txn = db.transaction(() => {
    // 1. Находим все rowid для source
    const rows = db.prepare(
      `SELECT rowid FROM kb_rowid_map WHERE source_id = ?`,
    ).all(sourceId) as Array<{ rowid: number | bigint }>;

    if (rows.length === 0) return;

    // 2. Удаляем из kb_vec_virtual (batch через IN)
    const placeholders = rows.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM kb_vec_virtual WHERE rowid IN (${placeholders})`,
    ).run(...rows.map(r => r.rowid));

    // 3. Удаляем из kb_rowid_map
    db.prepare(`DELETE FROM kb_rowid_map WHERE source_id = ?`).run(sourceId);
  });

  txn();
}

/**
 * Удалить один вектор чанка (для granular re-index одного чанка).
 *
 * Phase 2+: используется indexer'ом при инкрементальной реиндексации
 * изменившихся chunks (по contentHash diff).
 *
 * ВАЖНО: бросает ошибки наверх. Caller должен решить стратегию обработки
 * (логировать + продолжать, или abort + rollback Prisma chunk).
 */
export function deleteKbVector(chunkId: string): void {
  const db = getDbForKb();

  // P0-4 fix follow-up: delete by chunk_id. vec0 doesn't support DELETE with
  // subquery, so SELECT rowids first, then DELETE one by one.
  const txn = db.transaction(() => {
    const oldRowids = db.prepare(
      'SELECT rowid FROM kb_rowid_map WHERE chunk_id = ?',
    ).all(chunkId) as Array<{ rowid: bigint | number }>;
    for (const r of oldRowids) {
      db.prepare(`DELETE FROM kb_vec_virtual WHERE rowid = ?`).run(r.rowid);
    }
    db.prepare(`DELETE FROM kb_rowid_map WHERE chunk_id = ?`).run(chunkId);
  });

  txn();
}

/**
 * P-CORE-22 fix: batched delete of multiple chunk vectors in a single
 * transaction. Previously `search.ts` called `deleteKbVector(chunkId)` in a
 * loop via `setImmediate`, each its own transaction — slow under load and
 * prone to N concurrent deletions racing on the same ghost list.
 *
 * Also respects SQLite's variable limit by chunking to 500 IDs per statement.
 */
export function deleteKbVectorsBatch(chunkIds: string[]): number {
  if (chunkIds.length === 0) return 0;
  const db = getDbForKb();
  let deleted = 0;
  const CHUNK = 500;  // SQLite default SQLITE_MAX_VARIABLE_NUMBER is 999.
  for (let i = 0; i < chunkIds.length; i += CHUNK) {
    const batch = chunkIds.slice(i, i + CHUNK);
    const placeholders = batch.map(() => '?').join(',');
    const txn = db.transaction(() => {
      const rowids = db.prepare(
        `SELECT rowid FROM kb_rowid_map WHERE chunk_id IN (${placeholders})`,
      ).all(...batch) as Array<{ rowid: bigint | number }>;
      for (const r of rowids) {
        db.prepare(`DELETE FROM kb_vec_virtual WHERE rowid = ?`).run(r.rowid);
      }
      const info = db.prepare(
        `DELETE FROM kb_rowid_map WHERE chunk_id IN (${placeholders})`,
      ).run(...batch);
      deleted += info.changes;
    });
    txn();
  }
  return deleted;
}

// ============================================================================
// Stats — для diagnostics и UI
// ============================================================================

/**
 * Количество векторов в kb_vec_virtual (для diagnostics и UI badge).
 *
 * Возвращает 0 если table не существует (fresh install до первого indexing).
 */
export function countKbVectors(): number {
  try {
    const db = getDbForKb();
    const row = db.prepare(`SELECT COUNT(*) as count FROM kb_rowid_map`).get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/** Векторы одного source (для orphan-check перед skip reindex). */
export function countKbVectorsForSource(sourceId: string): number {
  try {
    const db = getDbForKb();
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM kb_rowid_map WHERE source_id = ?`,
    ).get(sourceId) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/** chunk_id, у которых есть вектор в kb_rowid_map для данного source. */
export function listKbVectorChunkIdsForSource(sourceId: string): Set<string> {
  try {
    const db = getDbForKb();
    const rows = db.prepare(
      `SELECT chunk_id FROM kb_rowid_map WHERE source_id = ?`,
    ).all(sourceId) as Array<{ chunk_id: string }>;
    return new Set(rows.map(r => r.chunk_id));
  } catch {
    return new Set();
  }
}
