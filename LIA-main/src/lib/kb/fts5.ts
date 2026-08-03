import 'server-only';

// ============================================================================
// FTS5 — native SQLite full-text search (если доступен).
// ============================================================================
//
// better-sqlite3 prebuilt binaries НЕ включают FTS5 на большинстве платформ.
// Но если пользователь пересобрал better-sqlite3 с SQLITE_ENABLE_FTS5 —
// FTS5 доступен и работает в 10-100× быстрее JS BM25, с native porter
// stemmer и unicode61 tokenizer.
//
// Этот модуль делает runtime detection: пытаемся CREATE VIRTUAL TABLE
// USING fts5 — если succeeds, FTS5 available. Если fails — fallback на
// JS BM25 (bm25.ts).
//
// Progressive enhancement: если FTS5 есть — используем его. Если нет —
// текущий JS BM25 работает как раньше. Никаких breaking changes.
//
// Benefits FTS5 over JS BM25:
//   - Native C implementation, ~10-100× faster
//   - Built-in porter stemmer (no need for snowball-stemmers)
//   - Built-in BM25 ranking function (bm25() SQL function)
//   - unicode61 tokenizer handles Cyrillic out of the box
//   - No manual inverted index maintenance (SQLite manages internally)
//   - No cached stats tables (kb_index_stats, kb_term_df) needed
//
// Build instructions for enabling FTS5:
//   Linux/macOS:
//     npm rebuild better-sqlite3 --build-from-source --define SQLITE_ENABLE_FTS5
//   Windows (needs Visual Studio Build Tools):
//     npm rebuild better-sqlite3 --build-from-source --define SQLITE_ENABLE_FTS5
//   Or set in .npmrc:
//     better_sqlite3_build_from_source=true
//     better_sqlite3_define=SQLITE_ENABLE_FTS5

import { getDb } from '@/lib/db-vec';
import { logger } from '@/lib/logger';

let _fts5Available: boolean | null = null;
let _fts5Initialized = false;

/**
 * Проверить доступность FTS5 в текущем better-sqlite3.
 *
 * Создаёт временную FTS5 table — если succeeds, FTS5 available.
 * Результат кэшируется (FTS5 support не меняется в runtime).
 */
export function isFts5Available(): boolean {
  if (_fts5Available !== null) return _fts5Available;

  try {
    const db = getDb();
    // Try to create a temporary FTS5 table
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_test USING fts5(content)');
    db.exec('DROP TABLE IF EXISTS __fts5_test');
    _fts5Available = true;
    logger.info('db', 'FTS5 is available — will use native full-text search for BM25');
  } catch (e) {
    _fts5Available = false;
    logger.info('db', 'FTS5 not available — falling back to JS BM25. To enable: npm rebuild better-sqlite3 --build-from-source --define SQLITE_ENABLE_FTS5');
  }

  return _fts5Available;
}

/**
 * Инициализировать FTS5 table для KB chunks.
 * Вызывается при первом использовании FTS5.
 *
 * Table schema:
 *   kb_fts5(content TEXT, source_id UNINDEXED, chunk_id UNINDEXED)
 *
 * content — текст chunk для full-text search
 * source_id, chunk_id — UNINDEXED (не участвуют в search, только для JOIN)
 *
 * Tokenizer: unicode61 (handles Cyrillic) + remove_diacritics=2
 * Stemmer: porter (встроенный, для English; для Russian unicode61 достаточно)
 */
function ensureFts5Table(): void {
  if (_fts5Initialized) return;
  if (!isFts5Available()) return;

  const db = getDb();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts5 USING fts5(
        content,
        source_id UNINDEXED,
        chunk_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    _fts5Initialized = true;
    logger.info('db', 'kb_fts5 table ready');
  } catch (e) {
    logger.error('db', 'Failed to create kb_fts5 table', {}, e);
    _fts5Available = false;  // fallback to JS BM25
  }
}

/**
 * Добавить chunk в FTS5 index.
 * Вызывается из inverted-index.ts если FTS5 available.
 */
export function addToFts5Index(params: {
  chunkId: string;
  sourceId: string;
  content: string;
}): void {
  if (!isFts5Available()) return;
  ensureFts5Table();

  try {
    const db = getDb();
    // Удаляем существующую запись с тем же chunk_id (идемпотентность)
    db.prepare('DELETE FROM kb_fts5 WHERE chunk_id = ?').run(params.chunkId);
    // Вставляем новую
    db.prepare(`
      INSERT INTO kb_fts5 (content, source_id, chunk_id)
      VALUES (?, ?, ?)
    `).run(params.content, params.sourceId, params.chunkId);
  } catch (e) {
    logger.warn('db', 'addToFts5Index failed (non-fatal)', {
      chunkId: params.chunkId.slice(0, 8),
    }, e);
  }
}

/**
 * Удалить chunk из FTS5 index.
 */
export function removeFromFts5Index(chunkId: string): void {
  if (!isFts5Available()) return;
  ensureFts5Table();

  try {
    const db = getDb();
    db.prepare('DELETE FROM kb_fts5 WHERE chunk_id = ?').run(chunkId);
  } catch (e) {
    logger.warn('db', 'removeFromFts5Index failed (non-fatal)', {
      chunkId: chunkId.slice(0, 8),
    }, e);
  }
}

/**
 * Удалить все entries для source из FTS5 index.
 */
export function removeSourceFromFts5Index(sourceId: string): void {
  if (!isFts5Available()) return;
  ensureFts5Table();

  try {
    const db = getDb();
    db.prepare('DELETE FROM kb_fts5 WHERE source_id = ?').run(sourceId);
  } catch (e) {
    logger.warn('db', 'removeSourceFromFts5Index failed (non-fatal)', {
      sourceId: sourceId.slice(0, 8),
    }, e);
  }
}

/**
 * BM25 search через FTS5.
 *
 * Использует встроенную bm25() функцию SQLite для ранжирования.
 * Возвращает chunk_ids + scores, отсортированные по убыванию relevance.
 *
 * @returns массив { chunk_id, source_id, score } или [] если FTS5 недоступен
 */
export function fts5Search(params: {
  query: string;
  sourceIds?: string[];
  limit: number;
}): Array<{ chunk_id: string; source_id: string; score: number }> {
  if (!isFts5Available()) return [];
  ensureFts5Table();

  try {
    const db = getDb();

    // FTS5 MATCH query: разбиваем query на tokens, ищем ANY (OR logic).
    // Для AND logic — используем пробелы между terms.
    // Для mixed — используем OR для лучшего recall.
    const queryTokens = params.query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 1)
      .map(t => t.replace(/['"]/g, ''));  // sanitize — remove quotes

    if (queryTokens.length === 0) return [];

    // FTS5 MATCH syntax: "term1 OR term2 OR term3"
    const matchExpr = queryTokens.map(t => `"${t}"`).join(' OR ');

    let sourceFilter = '';
    const args: Array<string | number> = [];

    if (params.sourceIds && params.sourceIds.length > 0) {
      const placeholders = params.sourceIds.map(() => '?').join(',');
      sourceFilter = ` AND source_id IN (${placeholders})`;
      args.push(...params.sourceIds);
    }

    // bm25() возвращает negative score (lower = better). Мы инвертируем.
    const rows = db.prepare(`
      SELECT chunk_id, source_id, bm25(kb_fts5) as score
      FROM kb_fts5
      WHERE kb_fts5 MATCH ?${sourceFilter}
      ORDER BY score ASC
      LIMIT ?
    `).all(matchExpr, ...args, params.limit) as Array<{
      chunk_id: string;
      source_id: string;
      score: number;
    }>;

    // Инвертируем score (bm25 возвращает negative, мы хотим positive)
    return rows.map(r => ({
      chunk_id: r.chunk_id,
      source_id: r.source_id,
      score: -r.score,  // bm25: lower (more negative) = better, so negate
    }));
  } catch (e) {
    logger.warn('db', 'fts5Search failed (non-fatal)', {}, e);
    return [];
  }
}

/**
 * Очистить весь FTS5 index (для reindex при смене токенизатора).
 */
export function clearFts5Index(): void {
  if (!isFts5Available()) return;
  ensureFts5Table();

  try {
    const db = getDb();
    db.exec('DELETE FROM kb_fts5');
  } catch (e) {
    logger.warn('db', 'clearFts5Index failed (non-fatal)', {}, e);
  }
}
