import 'server-only';

// ============================================================================
// KB reconciliation — периодическая сверка консистентности между Prisma Chunk
// и raw-SQL индексами (kb_vec_virtual, kb_inverted_index).
// ============================================================================
//
// Запускается на server startup + каждые 10 минут (setInterval). Логирует
// расхождения, удаляет ghost entries (вектор/posting есть, chunk'а нет),
// репортит orphaned chunks (chunk есть, вектора нет — нужен ручной reindex).
//
// Не блокирует search/index — все операции best-effort, ошибки логируются.
//
// Контекст: даже с outbox pattern (который ещё не реализован) возможны race
// conditions при crash процесса mid-write. Reconciliation — safety net.

import { db } from '@/lib/db';
import { getDb } from '@/lib/db-vec';
import { deleteKbVector } from './db-vec-kb';
import { removeFromInvertedIndex } from './inverted-index';
import { logger } from '@/lib/logger';

const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;  // 10 минут

let reconcileTimer: NodeJS.Timeout | null = null;

/**
 * Запустить periodic reconciliation.
 * Вызывается на server startup (см. server-startup.ts).
 * Idempotent — повторные вызовы пропускают запуск.
 */
export function startKbReconciliation(): void {
  // HMR-safe: проверяем globalThis как в server-startup.ts
  const g = globalThis as unknown as { __lia_kb_reconcile_timer__?: NodeJS.Timeout };
  if (g.__lia_kb_reconcile_timer__ || reconcileTimer) {
    logger.debug('kb', 'KB reconciliation already running, skipping');
    return;
  }

  // First run after 60 sec — даём серверу подняться
  setTimeout(() => {
    reconcileKbIndex().catch((e) => {
      logger.warn('kb', 'Initial KB reconciliation failed', {}, e);
    });
  }, 60_000);

  // Regular cycle
  const timer = setInterval(() => {
    reconcileKbIndex().catch((e) => {
      logger.warn('kb', 'KB reconciliation cycle failed', {}, e);
    });
  }, RECONCILE_INTERVAL_MS);

  reconcileTimer = timer;
  g.__lia_kb_reconcile_timer__ = timer;

  logger.info('kb', `KB reconciliation started (${Math.round(RECONCILE_INTERVAL_MS / 1000)}s interval)`);
}

/**
 * Остановить periodic reconciliation.
 * Вызывается на process.on('beforeExit').
 */
export function stopKbReconciliation(): void {
  const g = globalThis as unknown as { __lia_kb_reconcile_timer__?: NodeJS.Timeout };
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (g.__lia_kb_reconcile_timer__) {
    clearInterval(g.__lia_kb_reconcile_timer__);
    delete g.__lia_kb_reconcile_timer__;
  }
  logger.info('kb', 'KB reconciliation stopped');
}

/**
 * Одноразовая сверка консистентности KB индексов.
 *
 * Проверяет:
 *   1. Ghost vectors — chunk_id есть в kb_rowid_map, но нет в Prisma Chunk.
 *      Удаляет такие векторы.
 *   2. Ghost postings — chunk_id есть в kb_inverted_index, но нет в Prisma Chunk.
 *      Удаляет такие postings.
 *   3. Orphaned chunks — chunk есть в Prisma, но нет вектора. НЕ удаляет
 *      (нужен Ollama для пере-embed'а). Логирует для ручного reindex.
 *
 * @returns сводка: сколько найдено и исправлено расхождений
 */
async function reconcileKbIndex(): Promise<{
  ghostVectors: number;
  ghostPostings: number;
  orphanedChunks: number;
}> {
  logger.debug('kb', 'Running KB reconciliation...');

  // ── 1. Получаем все chunk_ids из Prisma (source of truth) ──
  const prismaChunks = await db.chunk.findMany({
    select: { id: true, sourceId: true },
  });
  const prismaChunkIds = new Set(prismaChunks.map(c => c.id));

  // ── 2. Получаем все chunk_ids из kb_rowid_map ──
  let vectorChunkIds: string[] = [];
  let ghostVectorIds: string[] = [];
  try {
    const sqliteDb = getDb();
    const vectorRows = sqliteDb.prepare(
      `SELECT DISTINCT chunk_id FROM kb_rowid_map`,
    ).all() as Array<{ chunk_id: string }>;
    vectorChunkIds = vectorRows.map(r => r.chunk_id);

    // Ghost vectors — есть в векторном индексе, нет в Prisma
    ghostVectorIds = vectorChunkIds.filter(id => !prismaChunkIds.has(id));

    // Удаляем ghost vectors (batch, не блокируя search)
    if (ghostVectorIds.length > 0) {
      let deleted = 0;
      for (const chunkId of ghostVectorIds) {
        try {
          deleteKbVector(chunkId);
          deleted++;
        } catch (e) {
          logger.warn('kb', 'Reconciliation: failed to delete ghost vector', {
            chunkId: chunkId.slice(0, 8),
          }, e);
        }
      }
      logger.info('kb', `Reconciliation: deleted ${deleted}/${ghostVectorIds.length} ghost vectors`);
    }
  } catch (e) {
    // kb_rowid_map может не существовать на fresh install — non-fatal
    logger.debug('kb', 'Reconciliation: kb_rowid_map not available, skipping vector check');
  }

  // ── 3. Получаем все chunk_ids из kb_inverted_index ──
  let ghostPostingIds: string[] = [];
  try {
    const sqliteDb = getDb();
    // Убедимся что таблица существует
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

    const postingRows = sqliteDb.prepare(
      `SELECT DISTINCT chunk_id FROM kb_inverted_index`,
    ).all() as Array<{ chunk_id: string }>;
    const postingChunkIds = postingRows.map(r => r.chunk_id);

    // Ghost postings — есть в inverted index, нет в Prisma
    ghostPostingIds = postingChunkIds.filter(id => !prismaChunkIds.has(id));

    if (ghostPostingIds.length > 0) {
      let deleted = 0;
      for (const chunkId of ghostPostingIds) {
        try {
          removeFromInvertedIndex(chunkId);
          deleted++;
        } catch (e) {
          logger.warn('kb', 'Reconciliation: failed to delete ghost posting', {
            chunkId: chunkId.slice(0, 8),
          }, e);
        }
      }
      logger.info('kb', `Reconciliation: deleted ${deleted}/${ghostPostingIds.length} ghost postings`);
    }
  } catch (e) {
    logger.debug('kb', 'Reconciliation: kb_inverted_index not available, skipping posting check');
  }

  // ── 4. Orphaned chunks — есть в Prisma, нет в векторном индексе ──
  // Это chunks без embeddings (manifest-only folder sources — нормально).
  // document/url/folder/codebase — при рассинхроне нужен reindex.
  // Не удаляем — только репортим.
  const vectorChunkIdSet = new Set(vectorChunkIds);
  const orphanedChunkIds = prismaChunks
    .filter(c => !vectorChunkIdSet.has(c.id))
    .map(c => ({ id: c.id, sourceId: c.sourceId }));

  // Группируем orphaned chunks по sourceId для понятного лога
  if (orphanedChunkIds.length > 0) {
    const bySource = new Map<string, number>();
    for (const c of orphanedChunkIds) {
      bySource.set(c.sourceId, (bySource.get(c.sourceId) ?? 0) + 1);
    }
    // Загружаем type этих source'ов чтобы отличить manifest-only (нормально)
    // от document/folder/url (баг, нужен reindex)
    const sourceIds = Array.from(bySource.keys());
    const sources = await db.source.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, type: true, name: true },
    });
    const sourceMap = new Map(sources.map(s => [s.id, s]));

    const problemOrphans: Array<{ sourceId: string; name: string; type: string; count: number }> = [];
    for (const [sourceId, count] of bySource) {
      const src = sourceMap.get(sourceId);
      // folder sources с manifest mode — нормально (нет embeddings).
      // document/url/folder — проблема.
      if (src && src.type !== 'folder') {
        problemOrphans.push({ sourceId, name: src.name, type: src.type, count });
      }
    }

    if (problemOrphans.length > 0) {
      logger.warn(
        'kb',
        `Reconciliation: ${problemOrphans.length} source(s) with orphaned chunks (chunk exists, no vector). Manual reindex needed.`,
        {
          sources: problemOrphans.map(p => ({ name: p.name, type: p.type, count: p.count })),
        },
      );
    }
  }

  const summary = {
    ghostVectors: ghostVectorIds.length,
    ghostPostings: ghostPostingIds.length,
    orphanedChunks: orphanedChunkIds.length,
  };

  if (summary.ghostVectors > 0 || summary.ghostPostings > 0) {
    logger.info('kb', 'KB reconciliation complete', summary);
  } else {
    logger.debug('kb', 'KB reconciliation complete (no issues)', summary);
  }

  return summary;
}
