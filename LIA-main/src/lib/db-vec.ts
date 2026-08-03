import 'server-only';

// SQLite + sqlite-vec for vector ops.
//
// Architecture:
//   - VectorMemory table (managed by Prisma) stores text + metadata + embedding BLOB
//   - vec0 virtual table (managed here) is a separate index pointing to VectorMemory rows
//   - We sync them: on insert into VectorMemory, also insert into vec_virtual
//   - Search: query vec_virtual with MATCH + pre-filter by episode_id, JOIN back to VectorMemory
//
// Why virtual table instead of scalar function:
//   - vec0 supports KNN search with LIMIT + WHERE in one query (faster)
//   - Pre-filtering by episode_id is native SQL WHERE
//   - No need to scan all rows and compute cosine manually
//
// LAZY INITIALIZATION:
//   The DB connection, sqlite-vec extension loading, and Prisma schema assertion
//   are deferred to the first actual vector operation (insert/search/delete).
//   This is critical because `next build` evaluates this module during page
//   data collection for /api/chat — if we opened the DB at module load time,
//   the build would fail when `bun run db:push` hasn't been run yet (e.g. in
//   CI or on a fresh clone). With lazy init, the build succeeds because no
//   vector operations are performed during static analysis.

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveSqliteVecPath, resolveDbPath } from '@/lib/paths';
import { logger } from '@/lib/logger';

// ============================================================================
// Lazy DB singleton — opened on first use, survives HMR in dev
// ============================================================================
const globalForVec = globalThis as unknown as { __vecDb?: Database.Database };
let _db: Database.Database | null = null;

/**
 * Get the better-sqlite3 Database instance.
 *
 * Opens the DB, loads the sqlite-vec extension, asserts that all Prisma-managed
 * tables exist, and creates the vec0 virtual table + mapping table on first call.
 * Subsequent calls return the cached singleton.
 *
 * This is intentionally lazy — see module-level comment for rationale.
 *
 * Exported since KB Phase 1: the Knowledge Base layer
 * (`src/lib/kb/db-vec-kb.ts`) reuses this singleton to add its own `kb_vec_virtual`
 * vec0 table next to `vec_virtual` — opening a second `Database` instance would
 * conflict with WAL mode and cause lock errors. All KB vector ops go through
 * `getDbForKb()` in `db-vec-kb.ts`, which calls this function under the hood.
 */
export function getDb(): Database.Database {
  if (_db) return _db;
  if (globalForVec.__vecDb) {
    _db = globalForVec.__vecDb;
    return _db;
  }

  const DB_PATH = resolveDbPath(process.env.DATABASE_URL);
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  // ── SQLite tuning для single-user local-first desktop ──
  //
  // journal_mode = WAL: Write-Ahead Logging. Reads не блокируют writes,
  //   multiple readers + 1 writer concurrent. Persisted в DB header —
  //   survives restart.
  //
  // synchronous = NORMAL: В WAL режиме это даёт 2-3× faster writes vs FULL.
  //   Trade-off: при crash системы (не процесса) могут потеряться последние
  //   несколько транзакций из WAL (не fsync'нутых). Для single-user desktop
  //   с periodic backup — acceptable. Для сервера с сотнями транзакций/sec
  //   — нужен FULL. См. https://sqlite.org/pragma.html#pragma_synchronous
  //
  // foreign_keys = ON: Prisma ожидает FK constraints. Без этого cascade
  //   deletes не работают.
  //
  // busy_timeout = 10000: 10 сек retry при SQLITE_BUSY. Спасает когда Prisma
  //   и better-sqlite3 конкурируют за write lock.
  //
  // temp_store = MEMORY: Временные таблицы и индексы в RAM, не на диске.
  //   Ускоряет сложные запросы (GROUP BY, ORDER BY на больших таблицах).
  //
  // wal_autocheckpoint = 1000: Default 1000 страниц (4MB). Явно указываем
  //   чтобы не зависеть от дефолта SQLite. При достижении threshold WAL
  //   автоматически merge'ится в основной файл.
  //
  // mmap_size = 268435456 (256MB): Memory-mapped I/O для read operations.
  //   Ускоряет search на больших БД. 256MB — reasonable upper bound для
  //   desktop. На 32-bit системах может быть проблема, но мы предполагаем
  //   64-bit.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('mmap_size = 268435456');

  // Load sqlite-vec extension
  try {
    const vecPath = resolveSqliteVecPath();
    db.loadExtension(vecPath);
    logger.info('db', `sqlite-vec loaded`, { path: vecPath });
  } catch (e) {
    logger.error('db', 'Failed to load sqlite-vec extension', {}, e);
    throw e;
  }

  // Create vec0 virtual table — 768-dim float vectors (nomic-embed-text dimension)
  // We store episode_id as a metadata column for pre-filtering.
  try {
    // ── Sanity check: Prisma schema must already be applied ──
    // Earlier this module used to CREATE TABLE VectorMemory / EmotionalMemory
    // itself as a fallback for users who hadn't run `bun run db:push`. That
    // fallback was dangerous: if Prisma and better-sqlite3 disagreed on the
    // DB path (see audit §2.1), this code silently created a SECOND, empty
    // database and the Prisma-managed rows never landed in vec_virtual.
    // We now require the user to run `bun run db:push` first and assert that
    // the Prisma-managed tables exist before we touch anything.
    //
    // KB tables (Source/Chunk) are optional: they were added in KB
    // Phase 1 and may not exist yet on databases created before that. We
    // soft-check them — if missing, KB layer (`db-vec-kb.ts`) will create
    // `kb_vec_virtual` but Prisma queries against Source/Chunk will
    // fail with "no such table", prompting the user to run `bun run db:push`.
    const requiredPrismaTables = [
      'Episode', 'Message', 'VectorMemory', 'EmotionalMemory',
      'AgentTask', 'Setting',
    ];
    const missing = requiredPrismaTables.filter(t => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(t) as { name: string } | undefined;
      return !row;
    });
    if (missing.length > 0) {
      const msg =
        `DB schema mismatch: Prisma-managed tables missing in ${DB_PATH}: ${missing.join(', ')}. ` +
        `Run 'bun run db:push' from the project root first. ` +
        `If you already did, the DB path may have drifted — check that DATABASE_URL ` +
        `(currently: ${process.env.DATABASE_URL ?? '(unset)'}) resolves to the same file ` +
        `for both Prisma (relative to prisma/schema.prisma) and better-sqlite3 ` +
        `(relative to process.cwd()).`;
      logger.error('db', 'Prisma schema not applied', { missing, dbPath: DB_PATH });
      throw new Error(msg);
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_virtual USING vec0(
        embedding float[768],
        episode_id text,
        source_type text
      )
    `);

    // Mapping table: vec0 rowid (integer) → VectorMemory id (UUID string) + episode_id
    // Created at init so that search doesn't fail with "no such table" on first call
    // (which happens before any insertVectorMemory has been called).
    db.exec(`
      CREATE TABLE IF NOT EXISTS vec_rowid_map (
        rowid INTEGER PRIMARY KEY,
        vector_id TEXT NOT NULL,
        episode_id TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_rowid_map_episode ON vec_rowid_map(episode_id)`);

    logger.info('db', 'vec_virtual + vec_rowid_map ready (Prisma tables verified)');
  } catch (e) {
    logger.error('db', 'Failed to create vec tables', {}, e);
    throw e;
  }

  globalForVec.__vecDb = db;
  _db = db;
  return _db;
}

// NOTE: `db` НЕ экспортируется напрямую. Все операции с vec index
// проходят через функции-обёртки ниже (insertVectorMemory, searchVectorsInEpisode,
// deleteVectorsInEpisode, insertEmotionalVectorIndex, searchEmotionalVectorsInEpisode,
// deleteEmotionalVectorsByEpisodeId).
// Это инкапсулирует vec0 virtual table и предотвращает прямой SQL-доступ
// из других модулей (emotional-memory.ts раньше импортировал vecDb и писал
// raw SQL — теперь использует обёртки).

// ============================================================================
// Vector operations — dialogue memory (VectorMemory table + vec_virtual index)
// ============================================================================

/**
 * Pack a Float32Array as a Buffer for BLOB storage.
 */
function packEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Insert a vector memory row.
 * Writes to BOTH VectorMemory (Prisma-managed, full data) AND vec_virtual (vec0 index).
 *
 * Все 3 записи обёрнуты в транзакцию better-sqlite3 — если любая падает,
 * откатываются все. Решает проблему orphaned VectorMemory rows,
 * которые не находятся векторным поиском, но учитываются в COUNT.
 */
export function insertVectorMemory(params: {
  id: string;
  episodeId: string;
  sourceType: string;
  text: string;
  embedding: Float32Array;
}): void {
  const db = getDb();
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;
  const rowid = generateRandomRowid();

  const txn = db.transaction(() => {
    // 0. Delete existing entries for this vector_id (idempotent re-insert).
    //    Rowids are random (P0-4); vec_rowid_map is the source of truth.
    //    vec0 doesn't support DELETE with subquery, so SELECT rowids first.
    const oldRowids = db.prepare(
      'SELECT rowid FROM vec_rowid_map WHERE vector_id = ?',
    ).all(params.id) as Array<{ rowid: bigint | number }>;
    for (const r of oldRowids) {
      db.prepare(`DELETE FROM vec_virtual WHERE rowid = ?`).run(r.rowid);
    }
    db.prepare(`DELETE FROM vec_rowid_map WHERE vector_id = ?`).run(params.id);

    // 1. Insert into VectorMemory (raw SQL — Prisma schema has this table)
    db.prepare(`
      INSERT OR REPLACE INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts)
      VALUES (@id, @episodeId, @sourceType, @text, @embedding, datetime('now'))
    `).run({
      id: params.id,
      episodeId: params.episodeId,
      sourceType: params.sourceType,
      text: params.text,
      embedding: packEmbedding(params.embedding),
    });

    // 2. Insert into vec_virtual index
    db.prepare(`
      INSERT INTO vec_virtual (rowid, embedding, episode_id, source_type)
      VALUES (?, vec_f32(?), ?, ?)
    `).run(rowid, embeddingStr, params.episodeId, params.sourceType);

    // 3. Store mapping rowid → id so we can JOIN back
    db.prepare(`INSERT INTO vec_rowid_map (rowid, vector_id, episode_id) VALUES (?, ?, ?)`)
      .run(rowid, params.id, params.episodeId);
  });

  txn();
}

/**
 * P0-4 fix (C-DB-1): Generate a collision-free sqlite-vec rowid.
 *
 * Formerly `hashToRowid(id)` — a Java-style 31-bit hash of the vector id.
 * Birthday-paradox collisions at ~46k rows caused silent data loss.
 *
 * Now: fresh UUID v4 (122 bits) → BigInt in [2^31, 2^63). Not derived from
 * any id argument; `vec_rowid_map` / `kb_rowid_map` map rowid ↔ vector/chunk.
 * Idempotent re-insert deletes by vector_id/chunk_id (lookup old rowids),
 * never by recomputing a hash of the id.
 *
 * Must return BigInt (G2): better-sqlite3 binds Number as float64 → vec0 reject.
 */
export function generateRandomRowid(): bigint {
  const uuid = randomUUID().replace(/-/g, '');
  const random62 = BigInt('0x' + uuid.slice(0, 16)) & (BigInt(1) << BigInt(62)) - BigInt(1);
  return (BigInt(1) << BigInt(31)) | random62;
}

/**
 * Semantic search WITHIN a single episode — pre-filtered at SQL level.
 *
 * Uses vec0 KNN search with WHERE episode_id = ? (AND optionally source_type = ?).
 * Returns top-N matches with similarity (1 - distance).
 *
 * sourceType filter решает cross-contamination: без него recall(dialogue)
 * мог вернуть emotional anchors, и наоборот. Теперь recall() в vector.ts
 * передаёт sourceType='dialogue', recallEmotionalAnchors — 'emotional'.
 */
export function searchVectorsInEpisode(params: {
  episodeId: string;
  queryEmbedding: Float32Array;
  limit?: number;
  minSimilarity?: number;
  sourceType?: string;  // если задан — фильтрует по source_type в vec_virtual
}): Array<{ id: string; sourceType: string; text: string; similarity: number }> {
  const { episodeId, queryEmbedding, limit = 5, minSimilarity = 0.3, sourceType } = params;
  const embeddingStr = `[${Array.from(queryEmbedding).join(',')}]`;
  const db = getDb();

  try {
    // vec0 KNN: MATCH должен идти последним в WHERE.
    // source_type filter добавляется только если задан (иначе возвращаем все типы).
    const sourceTypeClause = sourceType ? 'AND v.source_type = ?' : '';
    const stmt = db.prepare(`
      SELECT v.rowid, v.distance, m.vector_id as id
      FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ?
        ${sourceTypeClause}
        AND v.embedding MATCH vec_f32(?)
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance
    `);

    const bindParams: (string | number)[] = sourceType
      ? [episodeId, sourceType, embeddingStr, limit, 1 - minSimilarity]
      : [episodeId, embeddingStr, limit, 1 - minSimilarity];

    const rows = stmt.all(...bindParams) as Array<{
      rowid: number | bigint;
      distance: number;
      id: string;
    }>;

    if (rows.length === 0) return [];

    // Fetch text + sourceType from VectorMemory for matched ids.
    // Defence-in-depth: also filter by episodeId — even though vec_rowid_map
    // already filtered by episode_id, this prevents any theoretical leak
    // if vec_virtual/vec_rowid_map ever return ids from wrong episode.
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const metaStmt = db.prepare(`
      SELECT id, sourceType, text FROM VectorMemory WHERE id IN (${placeholders}) AND episodeId = ?
    `);
    const metas = metaStmt.all(...ids, episodeId) as Array<{ id: string; sourceType: string; text: string }>;
    const metaMap = new Map(metas.map(m => [m.id, m]));

    return rows
      .map(r => {
        const meta = metaMap.get(r.id);
        if (!meta) return null;
        return {
          id: r.id,
          sourceType: meta.sourceType,
          text: meta.text,
          similarity: 1 - r.distance,
        };
      })
      .filter((x): x is { id: string; sourceType: string; text: string; similarity: number } => x !== null);
  } catch (e) {
    logger.warn('db', `Vector search failed`, {
      episodeId: episodeId.slice(0, 8),
      sourceType: sourceType ?? 'any',
      limit,
      minSimilarity,
    }, e);
    return [];
  }
}

/**
 * Delete all vectors for an episode.
 *
 * Все 3 DELETE обёрнуты в транзакцию — гарантирует консистентность:
 * либо все vec_virtual + vec_rowid_map + VectorMemory записи удалены,
 * либо ни одна (откат).
 */
export function deleteVectorsInEpisode(episodeId: string): void {
  const db = getDb();
  const txn = db.transaction(() => {
    const rowids = db.prepare('SELECT rowid FROM vec_rowid_map WHERE episode_id = ?').all(episodeId) as Array<{ rowid: number | bigint }>;
    if (rowids.length > 0) {
      const placeholders = rowids.map(() => '?').join(',');
      db.prepare(`DELETE FROM vec_virtual WHERE rowid IN (${placeholders})`).run(...rowids.map(r => r.rowid));
    }
    db.prepare('DELETE FROM vec_rowid_map WHERE episode_id = ?').run(episodeId);
    db.prepare('DELETE FROM VectorMemory WHERE episodeId = ?').run(episodeId);
  });

  try {
    txn();
  } catch (e) {
    // Таблицы могут не существовать если DB не мигрирована — логируем, но не падаем.
    logger.warn('db', 'deleteVectorsInEpisode failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
  }
}

// ============================================================================
// Emotional memory vec operations — для emotional-memory.ts.
// ============================================================================
//
// Emotional anchors хранятся в Prisma EmotionalMemory table (полные данные),
// но индексируются в vec_virtual с source_type='emotional' для семантического поиска.
// vector_id имеет префикс "emo:" чтобы отличать от dialogue vectors.
//
// Раньше emotional-memory.ts импортировал vecDb напрямую и писал raw SQL.
// Теперь использует эти обёртки — инкапсуляция vec0 virtual table.

/**
 * Insert emotional anchor into vec_virtual index (atomic, transactional).
 * vector_id должен иметь префикс "emo:" для отличия от dialogue vectors.
 */
export function insertEmotionalVectorIndex(params: {
  vectorId: string;  // "emo:<cuid>"
  episodeId: string;
  embedding: Float32Array;
}): void {
  const db = getDb();
  const embeddingStr = `[${Array.from(params.embedding).join(',')}]`;
  const rowid = generateRandomRowid();

  const txn = db.transaction(() => {
    // Delete existing by vector_id (rowids are random — map is source of truth).
    // vec0 doesn't support DELETE with subquery, so SELECT rowids first.
    const oldRowids = db.prepare(
      'SELECT rowid FROM vec_rowid_map WHERE vector_id = ?',
    ).all(params.vectorId) as Array<{ rowid: bigint | number }>;
    for (const r of oldRowids) {
      db.prepare(`DELETE FROM vec_virtual WHERE rowid = ?`).run(r.rowid);
    }
    db.prepare(`DELETE FROM vec_rowid_map WHERE vector_id = ?`).run(params.vectorId);

    db.prepare(`
      INSERT INTO vec_virtual (rowid, embedding, episode_id, source_type)
      VALUES (?, vec_f32(?), ?, 'emotional')
    `).run(rowid, embeddingStr, params.episodeId);

    db.prepare(`INSERT INTO vec_rowid_map (rowid, vector_id, episode_id) VALUES (?, ?, ?)`)
      .run(rowid, params.vectorId, params.episodeId);
  });

  txn();
}

/**
 * Search emotional anchors in vec_virtual index (source_type='emotional').
 * Возвращает array of { vectorId, distance } — caller делает JOIN с Prisma
 * EmotionalMemory table для полных данных.
 */
export function searchEmotionalVectorsInEpisode(params: {
  episodeId: string;
  queryEmbedding: Float32Array;
  limit: number;
  maxDistance?: number;
}): Array<{ vectorId: string; distance: number }> {
  const { episodeId, queryEmbedding, limit, maxDistance = 0.9 } = params;
  const embeddingStr = `[${Array.from(queryEmbedding).join(',')}]`;
  const db = getDb();

  try {
    const rows = db.prepare(`
      SELECT v.rowid, v.distance, m.vector_id as id
      FROM vec_virtual v
      JOIN vec_rowid_map m ON v.rowid = m.rowid
      WHERE m.episode_id = ?
        AND v.source_type = 'emotional'
        AND v.embedding MATCH vec_f32(?)
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance
    `).all(episodeId, embeddingStr, limit, maxDistance) as Array<{
      rowid: number | bigint;
      distance: number;
      id: string;
    }>;

    return rows.map(r => ({ vectorId: r.id, distance: r.distance }));
  } catch (e) {
    logger.warn('db', 'searchEmotionalVectorsInEpisode failed', { episodeId: episodeId.slice(0, 8) }, e);
    return [];
  }
}

/**
 * P2-4 fix (M-DB): removed dead code `deleteEmotionalVectorsByEpisodeId`.
 * The function was never called anywhere — `deleteVectorsInEpisode` handles
 * deletion of ALL vectors (including emotional) for an episode via
 * vec_rowid_map.episode_id filter. The emotional-specific filter here was
 * redundant and misleading.
 */

/**
 * P1-1 fix (C-MEM-1): Delete a single emotional vector by its vector_id.
 * Used by reflection-engine.ts when consolidating anchors — the old anchor's
 * vec entry must be removed so recall doesn't return stale duplicates.
 */
export function deleteEmotionalVectorIndex(vectorId: string): void {
  const db = getDb();
  // P0-4 fix follow-up: vec0 doesn't support DELETE with subquery.
  const txn = db.transaction(() => {
    const oldRowids = db.prepare(
      'SELECT rowid FROM vec_rowid_map WHERE vector_id = ?',
    ).all(vectorId) as Array<{ rowid: bigint | number }>;
    for (const r of oldRowids) {
      db.prepare(`DELETE FROM vec_virtual WHERE rowid = ?`).run(r.rowid);
    }
    db.prepare(`DELETE FROM vec_rowid_map WHERE vector_id = ?`).run(vectorId);
  });

  try {
    txn();
  } catch (e) {
    logger.warn('db', 'deleteEmotionalVectorIndex failed (non-fatal)', { vectorId: vectorId.slice(0, 16) }, e);
  }
}

