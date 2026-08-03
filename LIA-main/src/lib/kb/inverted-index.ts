import 'server-only';

// ============================================================================
// BM25 Inverted Index — для масштабируемости на 100k+ chunks.
// ============================================================================
//
// Linear scan BM25 (bm25.ts) работает за O(N) на каждый query — приемлемо
// для 10k chunks (~100ms), но медленно для 100k+ (~1s+).
//
// Inverted index: term → list of (chunk_id, term_frequency).
// BM25 query: для каждого query term → lookup in index → score only matching chunks.
// O(Q * avg_postings_per_term) вместо O(N * Q).
//
// Реализация: SQLite таблица kb_inverted_index с (term, chunk_id, tf).
// Building index: при indexing chunk — tokenize + INSERT OR REPLACE.
// Query: SELECT chunk_id, SUM(...) FROM kb_inverted_index WHERE term IN (...) GROUP BY chunk_id.
//
// Использование: bm25Search проверяет размер corpus — если > THRESHOLD chunks,
// использует inverted index. Иначе — linear scan (проще, без overhead).

import { db } from '@/lib/db';
import { getDb } from '@/lib/db-vec';
import { tokenize } from './bm25';
import { logger } from '@/lib/logger';

// FTS5 — progressive enhancement. Если available (better-sqlite3 собран с
// SQLITE_ENABLE_FTS5) — используем native C full-text search вместо JS BM25.
// Если нет — fallback на JS inverted index (текущий код).
import {
  isFts5Available,
  addToFts5Index,
  removeFromFts5Index,
  removeSourceFromFts5Index,
  fts5Search,
  clearFts5Index,
} from './fts5';

// Threshold: если corpus > 5000 chunks, используем inverted index
const INVERTED_INDEX_THRESHOLD = 5000;

// ============================================================================
// Index management
// ============================================================================

let _indexInitialized = false;

// Bump при любом изменении логики tokenize() / snowballStem():
//   - v1: без стеммера
//   - v2: light stemmer (Porter-like EN + suffix-stripper RU, ~80% coverage)
//   - v3: Snowball stemmer (full Snowball algorithm, ~95% coverage)
//   - любое изменение stopword list
//   - любое изменение split regex
// При несовпадении stored version и KB_TOKENIZER_VERSION — server startup
// запускает фоновый reindex всех KB sources (см. server-startup.ts).
// Без этого старые postings в kb_inverted_index остаются со старыми
// токенами, а новые запросы идут через новый стеммер → silent recall
// degradation.
export const KB_TOKENIZER_VERSION = 3;  // v3 = Snowball stemmer

/**
 * Создать kb_inverted_index + kb_index_stats tables если не существуют.
 * Idempotent — повторные вызовы пропускают CREATE TABLE.
 */
function ensureIndexTable(): void {
  if (_indexInitialized) return;
  const sqliteDb = getDb();

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS kb_inverted_index (
      term TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      term_freq INTEGER NOT NULL,
      doc_length INTEGER NOT NULL,
      PRIMARY KEY (term, chunk_id)
    )
  `);
  sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_kb_inverted_term ON kb_inverted_index(term)`);
  sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_kb_inverted_source ON kb_inverted_index(source_id)`);
  // Index на chunk_id — критичен для O(log N) удаления при reindex.
  // Без него removeFromInvertedIndex делает full table scan.
  sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_kb_inverted_chunk ON kb_inverted_index(chunk_id)`);

  // Cached corpus statistics. Без этой таблицы каждый BM25-запрос делает
  // COUNT(DISTINCT chunk_id) и AVG(doc_length) — full table scans на 100k+
  // chunks = сотни ms. С кэшем — O(1) lookup.
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS kb_index_stats (
      key TEXT PRIMARY KEY,
      value REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Per-term document frequency cache. Без неё каждый запрос делает
  // GROUP BY term — full scan. С кэшем — O(log N) lookup per query term.
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS kb_term_df (
      term TEXT PRIMARY KEY,
      df INTEGER NOT NULL
    )
  `);

  _indexInitialized = true;
}

/**
 * Получить сохранённую версию токенизатора из kb_index_stats.
 * Возвращает 0 если записи нет (fresh install или pre-v2).
 */
export function getStoredTokenizerVersion(): number {
  ensureIndexTable();
  const sqliteDb = getDb();
  const row = sqliteDb.prepare(
    `SELECT value FROM kb_index_stats WHERE key = 'tokenizer_version'`,
  ).get() as { value: number } | undefined;
  return row?.value ?? 0;
}

/**
 * Записать текущую версию токенизатора в kb_index_stats.
 * Вызывается после успешного reindex всех sources.
 */
export function setStoredTokenizerVersion(version: number): void {
  ensureIndexTable();
  const sqliteDb = getDb();
  const now = Date.now();
  sqliteDb.prepare(`
    INSERT INTO kb_index_stats (key, value, updated_at)
    VALUES ('tokenizer_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(version, now);
}

/**
 * Проверить, нужна ли переиндексация из-за смены версии токенизатора.
 * Возвращает true если stored version != current (KB_TOKENIZER_VERSION).
 * Используется в server-startup.ts для запуска авто-reindex.
 */
export function isTokenizerVersionOutdated(): boolean {
  return getStoredTokenizerVersion() !== KB_TOKENIZER_VERSION;
}

/**
 * Сбросить весь inverted index (postings + cached stats + term df).
 * Используется перед полным reindex всех sources при смене токенизатора.
 * Не трогает Prisma Chunk table — только raw-SQL индекс.
 */
export function clearInvertedIndex(): void {
  ensureIndexTable();
  const sqliteDb = getDb();
  const txn = sqliteDb.transaction(() => {
    sqliteDb.exec(`DELETE FROM kb_inverted_index`);
    sqliteDb.exec(`DELETE FROM kb_term_df`);
    sqliteDb.prepare(`DELETE FROM kb_index_stats WHERE key IN ('total_docs', 'avg_doc_length')`).run();
    // tokenizer_version оставляем — обновим после reindex через setStoredTokenizerVersion
  });
  txn();

  // Also clear FTS5 if available
  clearFts5Index();
}

/**
 * Добавить chunk в inverted index.
 * Вызывается из indexer.ts после INSERT в Chunk table.
 *
 * Tokenize content → для каждого term: INSERT (term, chunk_id, tf, doc_length).
 * Также инкрементально обновляет кэш статистик (total_docs, avg_doc_length,
 * per-term df) — это убирает full table scans из BM25-запросов.
 *
 * ВАЖНО: бросает ошибки наверх. Раньше тут был silent try/catch — это приводило
 * к рассинхронизации inverted index с Prisma Chunk. Caller должен откатить
 * Prisma-запись при ошибке (см. indexer.ts).
 */
export function addToInvertedIndex(params: {
  chunkId: string;
  sourceId: string;
  content: string;
}): void {
  ensureIndexTable();
  const sqliteDb = getDb();
  const tokens = tokenize(params.content);
  if (tokens.length === 0) return;

  // Count term frequencies (unique terms only — для df cache)
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  const docLength = tokens.length;
  const now = Date.now();

  // Prepared statements
  const insertPosting = sqliteDb.prepare(`
    INSERT OR REPLACE INTO kb_inverted_index (term, chunk_id, source_id, term_freq, doc_length)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertTotalDocs = sqliteDb.prepare(`
    INSERT INTO kb_index_stats (key, value, updated_at)
    VALUES ('total_docs', 1, ?)
    ON CONFLICT(key) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at
  `);
  const getAvgDl = sqliteDb.prepare(`SELECT value FROM kb_index_stats WHERE key = 'avg_doc_length'`);
  const upsertAvgDl = sqliteDb.prepare(`
    INSERT INTO kb_index_stats (key, value, updated_at)
    VALUES ('avg_doc_length', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = excluded.updated_at
  `);
  const upsertTermDf = sqliteDb.prepare(`
    INSERT INTO kb_term_df (term, df)
    VALUES (?, 1)
    ON CONFLICT(term) DO UPDATE SET df = df + 1
  `);

  const txn = sqliteDb.transaction(() => {
    // Insert postings
    for (const [term, freq] of tf) {
      insertPosting.run(term, params.chunkId, params.sourceId, freq, docLength);
      // Increment per-term df (только уникальные термы в этом чанке —
      // tf Map уже содержит только уникальные key'ы)
      upsertTermDf.run(term);
    }

    // Update corpus stats: total_docs += 1, avg_doc_length recalculated
    upsertTotalDocs.run(now);
    const avgRow = getAvgDl.get() as { value: number } | undefined;
    const prevAvg = avgRow?.value ?? 0;
    // Получаем текущий total_docs (после инкремента)
    const totalRow = sqliteDb.prepare(
      `SELECT value FROM kb_index_stats WHERE key = 'total_docs'`,
    ).get() as { value: number } | undefined;
    const totalDocs = totalRow?.value ?? 1;
    // new_avg = (prev_avg * (n-1) + new_doc_length) / n
    const newAvg = ((prevAvg * (totalDocs - 1)) + docLength) / totalDocs;
    upsertAvgDl.run(newAvg, now, newAvg);
  });
  txn();

  // Also add to FTS5 if available (progressive enhancement)
  addToFts5Index({
    chunkId: params.chunkId,
    sourceId: params.sourceId,
    content: params.content,
  });
}

/**
 * Удалить chunk из inverted index.
 * Вызывается из indexer.ts при DELETE chunk.
 *
 * Также декрементально обновляет кэш статистик.
 *
 * ВАЖНО: бросает ошибки наверх. Caller решает стратегию обработки.
 */
export function removeFromInvertedIndex(chunkId: string): void {
  ensureIndexTable();
  const sqliteDb = getDb();
  const now = Date.now();

  // Get doc_length of this chunk (для avg recalculation) and unique terms
  // (для df decrement) before deleting
  const rows = sqliteDb.prepare(
    `SELECT term, doc_length FROM kb_inverted_index WHERE chunk_id = ?`,
  ).all(chunkId) as Array<{ term: string; doc_length: number }>;

  if (rows.length === 0) return;  // nothing to delete

  const docLength = rows[0].doc_length;
  const uniqueTerms = new Set(rows.map(r => r.term));

  const deletePostings = sqliteDb.prepare(`DELETE FROM kb_inverted_index WHERE chunk_id = ?`);
  const decrementTotalDocs = sqliteDb.prepare(`
    UPDATE kb_index_stats SET value = MAX(0, value - 1), updated_at = ?
    WHERE key = 'total_docs'
  `);
  const getAvgDl = sqliteDb.prepare(`SELECT value FROM kb_index_stats WHERE key = 'avg_doc_length'`);
  const updateAvgDl = sqliteDb.prepare(`
    UPDATE kb_index_stats SET value = ?, updated_at = ? WHERE key = 'avg_doc_length'
  `);
  const decrementTermDf = sqliteDb.prepare(`
    UPDATE kb_term_df SET df = MAX(0, df - 1) WHERE term = ?
  `);
  const deleteZeroDf = sqliteDb.prepare(`DELETE FROM kb_term_df WHERE df <= 0`);

  const txn = sqliteDb.transaction(() => {
    deletePostings.run(chunkId);

    // Decrement per-term df
    for (const term of uniqueTerms) {
      decrementTermDf.run(term);
    }
    deleteZeroDf.run();

    // Update corpus stats: total_docs -= 1, avg_doc_length recalculated
    decrementTotalDocs.run(now);
    const totalRow = sqliteDb.prepare(
      `SELECT value FROM kb_index_stats WHERE key = 'total_docs'`,
    ).get() as { value: number } | undefined;
    const totalDocs = totalRow?.value ?? 0;
    if (totalDocs > 0) {
      const avgRow = getAvgDl.get() as { value: number } | undefined;
      const prevAvg = avgRow?.value ?? 0;
      // new_avg = (prev_avg * (n+1) - deleted_doc_length) / n
      // P2-7 fix (M-KB): guard against negative avg_dl from floating-point drift.
      // Negative avgdl would produce negative BM25 scores and break result sorting.
      const rawNewAvg = ((prevAvg * (totalDocs + 1)) - docLength) / totalDocs;
      const newAvg = Math.max(0, rawNewAvg);
      updateAvgDl.run(newAvg, now);
    } else {
      // Last chunk deleted — reset avg
      updateAvgDl.run(0, now);
    }
  });
  txn();

  // Also remove from FTS5 if available
  removeFromFts5Index(chunkId);
}

/**
 * Удалить все entries для source из inverted index.
 * Вызывается при DELETE source.
 *
 * Также пересчитывает кэш статистик (cheaper: bulk delete + full recalc).
 *
 * ВАЖНО: бросает ошибки наверх. Caller решает стратегию обработки.
 */
export function removeSourceFromInvertedIndex(sourceId: string): void {
  ensureIndexTable();
  const sqliteDb = getDb();

  // Get all chunk_ids for this source — потом удалим их из kb_inverted_index
  // и пересчитаем статистики.
  const chunkRows = sqliteDb.prepare(
    `SELECT DISTINCT chunk_id FROM kb_inverted_index WHERE source_id = ?`,
  ).all(sourceId) as Array<{ chunk_id: string }>;

  if (chunkRows.length === 0) return;

  // Bulk delete all postings for this source
  sqliteDb.prepare(`DELETE FROM kb_inverted_index WHERE source_id = ?`).run(sourceId);

  // Recalculate stats from scratch (cheaper than incremental for bulk delete)
  recalcStats();

  // Also remove from FTS5 if available
  removeSourceFromFts5Index(sourceId);
}

/**
 * Пересчитать corpus statistics с нуля (full scan).
 * Используется после bulk operations (removeSource) и в reconciliation job.
 * Для per-chunk operations используйте incremental update (в addToInvertedIndex).
 */
function recalcStats(): void {
  ensureIndexTable();
  const sqliteDb = getDb();
  const now = Date.now();

  const statsRow = sqliteDb.prepare(`
    SELECT COUNT(DISTINCT chunk_id) as n, AVG(doc_length) as avgdl
    FROM kb_inverted_index
  `).get() as { n: number; avgdl: number | null } | undefined;

  const n = statsRow?.n ?? 0;
  const avgdl = statsRow?.avgdl ?? 0;

  // Upsert stats
  sqliteDb.prepare(`
    INSERT INTO kb_index_stats (key, value, updated_at)
    VALUES ('total_docs', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(n, now);
  sqliteDb.prepare(`
    INSERT INTO kb_index_stats (key, value, updated_at)
    VALUES ('avg_doc_length', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(avgdl, now);

  // Rebuild kb_term_df from scratch
  sqliteDb.exec(`DELETE FROM kb_term_df`);
  sqliteDb.exec(`
    INSERT INTO kb_term_df (term, df)
    SELECT term, COUNT(DISTINCT chunk_id) as df
    FROM kb_inverted_index
    GROUP BY term
  `);
}

// ============================================================================
// Query — BM25 через inverted index
// ============================================================================

interface InvertedIndexHit {
  chunk_id: string;
  source_id: string;
  score: number;
}

/**
 * BM25 search через inverted index ИЛИ FTS5 (если available).
 *
 * Если FTS5 доступен — используем его (native C, в 10-100× быстрее,
 * встроенный porter stemmer и bm25() ranking).
 * Если FTS5 недоступен — fallback на JS inverted index с cached stats.
 *
 * Возвращает chunk_ids + scores. Caller делает JOIN с Prisma Chunk для content.
 *
 * @returns empty array если index не initialized или нет matches
 */
export function bm25SearchInverted(params: {
  query: string;
  sourceIds?: string[];
  limit: number;
}): InvertedIndexHit[] {
  // ── FTS5 path (preferred) ──
  if (isFts5Available()) {
    const fts5Hits = fts5Search({
      query: params.query,
      sourceIds: params.sourceIds,
      limit: params.limit,
    });
    if (fts5Hits.length > 0) {
      return fts5Hits;
    }
    // If FTS5 returned 0 hits, fall through to JS inverted index
    // (FTS5 might be empty if chunks were indexed before FTS5 was enabled)
  }

  // ── JS inverted index path (fallback) ──
  return bm25SearchInvertedJs(params);
}

/**
 * BM25 search через JS inverted index (fallback если FTS5 недоступен).
 */
function bm25SearchInvertedJs(params: {
  query: string;
  sourceIds?: string[];
  limit: number;
}): InvertedIndexHit[] {
  // P1-4 fix (H-KB-3): enforce SQLITE_MAX_VARIABLE_NUMBER limit.
  // Use `let` because we may truncate queryTokens below.
  let queryTokens = tokenize(params.query);
  if (queryTokens.length === 0) return [];

  const SQLITE_MAX_VARS = 900;
  const totalVars = queryTokens.length + (params.sourceIds?.length ?? 0);
  if (totalVars > SQLITE_MAX_VARS) {
    const maxQueryTokens = SQLITE_MAX_VARS - (params.sourceIds?.length ?? 0);
    if (maxQueryTokens <= 0) {
      return [];
    }
    queryTokens = queryTokens.slice(0, maxQueryTokens);
  }

  try {
    ensureIndexTable();
    const sqliteDb = getDb();

    // Build placeholders for IN clause
    const placeholders = queryTokens.map(() => '?').join(',');
    const args: (string | number)[] = [...queryTokens];

    // Optional source filter
    let sourceFilter = '';
    if (params.sourceIds && params.sourceIds.length > 0) {
      const srcPlaceholders = params.sourceIds.map(() => '?').join(',');
      sourceFilter = ` AND source_id IN (${srcPlaceholders})`;
      args.push(...params.sourceIds);
    }

    // Get all postings for query terms
    const postings = sqliteDb.prepare(`
      SELECT term, chunk_id, source_id, term_freq, doc_length
      FROM kb_inverted_index
      WHERE term IN (${placeholders})${sourceFilter}
    `).all(...args) as Array<{
      term: string;
      chunk_id: string;
      source_id: string;
      term_freq: number;
      doc_length: number;
    }>;

    if (postings.length === 0) return [];

    // ── Cached corpus statistics (O(1) lookup вместо full table scans) ──
    // Раньше каждый запрос делал COUNT(DISTINCT chunk_id) и AVG(doc_length)
    // по всей kb_inverted_index — сотни ms на 100k+ chunks. Теперь берём из
    // кэша kb_index_stats, который обновляется инкрементально при add/remove.
    // Если кэш пустой (fresh install, stats не успели создаться) — fallback
    // на full scan.
    const totalDocsRow = sqliteDb.prepare(
      `SELECT value FROM kb_index_stats WHERE key = 'total_docs'`,
    ).get() as { value: number } | undefined;
    let N = totalDocsRow?.value ?? 0;
    let avgdl: number;

    if (N > 0) {
      // Cache hit — use cached avgdl
      const avgdlRow = sqliteDb.prepare(
        `SELECT value FROM kb_index_stats WHERE key = 'avg_doc_length'`,
      ).get() as { value: number } | undefined;
      avgdl = avgdlRow?.value ?? 1;
    } else {
      // Cache miss — full scan + populate cache
      const statsRow = sqliteDb.prepare(`
        SELECT COUNT(DISTINCT chunk_id) as n, AVG(doc_length) as avgdl
        FROM kb_inverted_index
      `).get() as { n: number; avgdl: number | null } | undefined;
      N = statsRow?.n ?? 1;
      avgdl = statsRow?.avgdl ?? 1;
      // Populate cache для следующих запросов
      try {
        const now = Date.now();
        sqliteDb.prepare(`
          INSERT INTO kb_index_stats (key, value, updated_at)
          VALUES ('total_docs', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(N, now);
        sqliteDb.prepare(`
          INSERT INTO kb_index_stats (key, value, updated_at)
          VALUES ('avg_doc_length', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(avgdl, now);
      } catch {
        // Non-fatal — cache write failed, next query will retry
      }
    }

    // ── Per-term document frequency (O(log N) lookup вместо GROUP BY) ──
    // Раньше: SELECT term, COUNT(DISTINCT chunk_id) ... GROUP BY term — full scan.
    // Теперь: SELECT df FROM kb_term_df WHERE term IN (...) — index lookup.
    // Fallback на GROUP BY если кэш пустой (fresh install).
    const df = new Map<string, number>();

    // Try cache first
    const dfCacheRows = sqliteDb.prepare(`
      SELECT term, df FROM kb_term_df WHERE term IN (${placeholders})
    `).all(...queryTokens) as Array<{ term: string; df: number }>;
    for (const row of dfCacheRows) {
      df.set(row.term, row.df);
    }

    // Если кэш вернул не все термы — fallback на GROUP BY для недостающих
    const missingTerms = queryTokens.filter(t => !df.has(t));
    if (missingTerms.length > 0) {
      const missingPlaceholders = missingTerms.map(() => '?').join(',');
      const dfRows = sqliteDb.prepare(`
        SELECT term, COUNT(DISTINCT chunk_id) as df
        FROM kb_inverted_index
        WHERE term IN (${missingPlaceholders})
        GROUP BY term
      `).all(...missingTerms) as Array<{ term: string; df: number }>;
      for (const row of dfRows) {
        df.set(row.term, row.df);
      }
    }

    // BM25 scoring: group postings by chunk_id
    const k1 = 1.5;
    const b = 0.75;
    const chunkScores = new Map<string, { score: number; source_id: string }>();

    for (const p of postings) {
      const d = df.get(p.term) ?? 0;
      const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
      const numerator = p.term_freq * (k1 + 1);
      const denominator = p.term_freq + k1 * (1 - b + b * (p.doc_length / avgdl));
      const termScore = idf * (numerator / denominator);

      const existing = chunkScores.get(p.chunk_id);
      if (existing) {
        existing.score += termScore;
      } else {
        chunkScores.set(p.chunk_id, { score: termScore, source_id: p.source_id });
      }
    }

    return Array.from(chunkScores.entries())
      .map(([chunk_id, { score, source_id }]) => ({ chunk_id, source_id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit);
  } catch (e) {
    logger.warn('kb', 'bm25SearchInverted failed (non-fatal)', {}, e);
    return [];
  }
}

/**
 * Проверить, нужно ли использовать inverted index для данного corpus size.
 *
 * @param corpusSize количество chunks в KB
 * @returns true если inverted index предпочтительнее linear scan
 */
export function shouldUseInvertedIndex(corpusSize: number): boolean {
  return corpusSize > INVERTED_INDEX_THRESHOLD;
}

/**
 * Получить размер corpus — общее количество chunks в KB.
 */
export async function getCorpusSize(): Promise<number> {
  try {
    return await db.chunk.count();
  } catch {
    return 0;
  }
}
