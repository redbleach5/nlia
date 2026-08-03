import 'server-only';

// ============================================================================
// KB Indexer — background indexing для document sources.
// ============================================================================
//
// Pipeline:
//   1. Parse file → markdown (.md/.txt; PDF, DOCX via parsers)
//   2. Chunk (DocumentChunker)
//   3. Delete old chunks + kb_vec_virtual entries (re-index)
//   4. Batch insert with embedding (dual-write to Chunk + kb_vec_virtual)
//      - Batch size 8 (10× меньше HTTP calls к Ollama)
//      - SQLite transactions для batch inserts (100× быстрее)
//   5. Update Source.status = 'ready' + chunkCount
//   6. Emit progress events через EventEmitter
//
// AbortController per source — позволяет отменить индексацию.
// Idempotent: повторный вызов для того же sourceId отменяет текущую и
// перезапускает.
//
// Error handling: при ошибке Source.status = 'error', errorMessage сохраняется.
// Partial results (chunks, записанные до ошибки) остаются в БД — это нормально,
// при следующей попытке reindex они будут удалены шагом 3.

import { db } from '@/lib/db';
import { embedBatchForKb, KB_EMBED_BATCH_SIZE } from './embed';
import { insertKbVector, deleteKbVector, countKbVectorsForSource, listKbVectorChunkIdsForSource } from './db-vec-kb';
import { addToInvertedIndex, removeFromInvertedIndex } from './inverted-index';
import { DocumentChunker, sha256, sha256Buffer } from './chunkers/document-chunker';
import { logger } from '@/lib/logger';
import { EventEmitter } from 'events';
import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { PATHS } from '@/lib/paths';
import type { DocumentSourceConfig, Chunk as KbChunk } from './types';

// ============================================================================
// Progress events
// ============================================================================

export interface IndexProgress {
  sourceId: string;
  phase: 'parsing' | 'chunking' | 'embedding' | 'inserting' | 'done' | 'error';
  processed: number;
  total: number;
  percent: number;
  errorMessage?: string;
}

export const indexEvents = new EventEmitter();
// Увеличиваем лимит listeners — UI может подписаться, plus internal listeners
indexEvents.setMaxListeners(20);

// ============================================================================
// Shared helpers (used by persistKbChunks, persistManifestChunks, indexUrlSource)
// ============================================================================

type ChunkCreateInput = {
  id: string;
  sourceId: string;
  content: string;
  summary?: string | null;
  contentHash: string;
  metadata: unknown;
  parentId: string | null;
  position: number;
};

function toChunkCreateData(chunk: ChunkCreateInput) {
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    content: chunk.content,
    summary: chunk.summary ?? null,
    contentHash: chunk.contentHash,
    metadata: JSON.stringify(chunk.metadata),
    parentId: chunk.parentId,
    position: chunk.position,
  };
}

/**
 * Batch-insert chunks in one SQL statement (createMany).
 *
 * Prefer this over interactive `$transaction` + N×`create`: Prisma's default
 * interactive timeout is 5s, and folder manifests (50 rows/batch on a busy
 * SQLite) can expire mid-batch (P2028). createMany is a single atomic INSERT.
 */
async function createChunksBatch(chunks: ChunkCreateInput[]): Promise<void> {
  if (chunks.length === 0) return;
  await db.chunk.createMany({
    data: chunks.map(toChunkCreateData),
  });
}

/**
 * Roll back a partial dual-write: Prisma chunk + kb_vec + inverted index.
 * Call when insertKbVector succeeds but addToInvertedIndex fails (or vice versa).
 */
export async function rollbackChunkWrite(chunkId: string): Promise<void> {
  await db.chunk.delete({ where: { id: chunkId } }).catch(() => null);
  try {
    deleteKbVector(chunkId);
    removeFromInvertedIndex(chunkId);
  } catch (e) {
    logger.warn('kb', 'rollbackChunkWrite: index cleanup failed (ghost may remain until reconcile)', {
      chunkId: chunkId.slice(0, 8),
    }, e);
  }
}

/**
 * Common error-finalize boilerplate for indexing functions.
 *
 * - If aborted (e.message === 'aborted'): set status='idle', emit error phase
 *   with 'Indexing cancelled' message, do NOT log as error.
 * - Otherwise: set status='error' with errorMessage, emit error phase, log.
 *
 * Used by indexDocumentSource, indexUrlSource, indexFolderSource, indexFolderSourceFull.
 */
export async function finalizeIndexingError(
  sourceId: string,
  e: unknown,
  emitProgress: (p: { phase: 'error'; processed: number; total: number; percent: number; errorMessage: string }) => void,
  logLabel: string,
): Promise<void> {
  const isAbort = e instanceof Error && e.message === 'aborted';
  const errorMessage = e instanceof Error ? e.message : String(e);

  await db.source.update({
    where: { id: sourceId },
    data: {
      status: isAbort ? 'idle' : 'error',
      errorMessage: isAbort ? null : errorMessage,
    },
  }).catch(() => null);

  emitProgress({
    phase: 'error',
    processed: 0,
    total: 0,
    percent: 0,
    errorMessage: isAbort ? 'Indexing cancelled' : errorMessage,
  });

  if (!isAbort) {
    logger.error('kb', `${logLabel} failed`, { sourceId: sourceId.slice(0, 8) }, e);
  }
}

// ============================================================================
// AbortController registry — per-source
// ============================================================================
//
// P-CORE-19 fix: previously `acquireIndexingController` aborted the previous
// controller but did NOT await its in-flight batch. The new indexer proceeded
// immediately and the old indexer's `finalizeIndexingError` would later
// overwrite the new run's `status='indexing'` with `status='idle'`, leaving
// the source in an inconsistent state. We now keep a per-sourceId `Promise`
// mutex — callers MUST `await waitForIndexing(sourceId)` BEFORE calling
// `acquireIndexingController`. The mutex is the promise of the in-flight run;
// it resolves in the run's `finally` block.

const indexAbortControllers = new Map<string, AbortController>();
const indexingMutex = new Map<string, Promise<unknown>>();

/**
 * P-CORE-19 fix: wait for any in-flight indexing run for this source to
 * complete. Call this BEFORE `acquireIndexingController` to serialize runs.
 * Safe to call when no run is in progress — returns immediately.
 */
export async function waitForIndexing(sourceId: string): Promise<void> {
  const inFlight = indexingMutex.get(sourceId);
  if (inFlight) {
    await inFlight.catch(() => null);  // ignore previous-run errors
  }
}

/**
 * Register the current run's promise. Callers MUST call `clearIndexingMutex`
 * in a `finally` block (typically alongside `releaseIndexingController`).
 */
export function setIndexingMutex(sourceId: string, promise: Promise<unknown>): void {
  indexingMutex.set(sourceId, promise);
}

export function clearIndexingMutex(sourceId: string): void {
  indexingMutex.delete(sourceId);
}

/**
 * Отменить текущую индексацию source.
 *
 * Idempotent: если для sourceId нет активной индексации — no-op.
 * Вызывает AbortController.abort() — текущая операция (embedding или insert)
 * получит AbortError и корректно завершится.
 */
export function abortIndexing(sourceId: string): void {
  const controller = indexAbortControllers.get(sourceId);
  if (controller) {
    controller.abort();
    indexAbortControllers.delete(sourceId);
    logger.info('kb', 'Indexing aborted', { sourceId: sourceId.slice(0, 8) });
  }
}

/**
 * Проверить, идёт ли сейчас индексация source.
 */
export function isIndexing(sourceId: string): boolean {
  return indexAbortControllers.has(sourceId);
}

/**
 * Сбросить зависшие KB sources в status='indexing' после рестарта сервера.
 */
export async function sweepStaleKbSources(): Promise<number> {
  const stale = await db.source.findMany({
    where: { status: 'indexing' },
    select: { id: true, name: true },
  });
  let swept = 0;
  for (const source of stale) {
    if (isIndexing(source.id)) continue;
    await db.source.update({
      where: { id: source.id },
      data: {
        status: 'idle',
        errorMessage:
          'Индексация прервана (рестарт сервера или сбой). Удалите источник или нажмите «Переиндексировать».',
      },
    });
    swept++;
    logger.info('kb', 'Swept stale KB indexing source', {
      sourceId: source.id.slice(0, 8),
      name: source.name,
    });
  }
  return swept;
}

/**
 * Захватить AbortController для индексации source (отменяет предыдущую, если была).
 *
 * P-CORE-19 fix: this is now SYNCHRONOUS again (no mutex await). Callers MUST
 * call `await waitForIndexing(sourceId)` BEFORE this to serialize runs.
 * The mutex and the controller are kept separate so callers can compose them
 * without deadlock (the mutex is the run's own promise — awaiting it from
 * inside acquire would deadlock).
 */
export function acquireIndexingController(sourceId: string): AbortController {
  const existing = indexAbortControllers.get(sourceId);
  if (existing) {
    existing.abort();
    indexAbortControllers.delete(sourceId);
  }
  const controller = new AbortController();
  indexAbortControllers.set(sourceId, controller);
  return controller;
}

export function releaseIndexingController(sourceId: string): void {
  indexAbortControllers.delete(sourceId);
}

/**
 * Incremental persist: embed + insert новых chunks, reuse unchanged по contentHash.
 */
export async function persistKbChunks(params: {
  sourceId: string;
  sourceType: string;
  chunks: KbChunk[];
  controller: AbortController;
  emitProgress: (p: Omit<IndexProgress, 'sourceId'>) => void;
}): Promise<number> {
  const { sourceId, sourceType, chunks, controller, emitProgress } = params;

  const existingChunks = await db.chunk.findMany({
    where: { sourceId },
    select: { id: true, contentHash: true, content: true, metadata: true, position: true, parentId: true },
  });

  // Orphan heal: chunk в Prisma без вектора — удаляем Prisma-row, чтобы
  // инкрементальный path заново embed'нул (иначе «File unchanged» / hash reuse
  // навсегда оставляют дыры в semantic search).
  const vectorIds = listKbVectorChunkIdsForSource(sourceId);
  const orphaned = existingChunks.filter(c => !vectorIds.has(c.id));
  if (orphaned.length > 0) {
    logger.warn('kb', 'Healing orphaned chunks (no vector) — will re-embed', {
      sourceId: sourceId.slice(0, 8),
      orphaned: orphaned.length,
      total: existingChunks.length,
    });
    for (const old of orphaned) {
      try {
        await db.chunk.delete({ where: { id: old.id } });
      } catch (e) {
        logger.warn('kb', 'Failed to delete orphaned chunk', { chunkId: old.id.slice(0, 8) }, e);
        continue;
      }
      try {
        removeFromInvertedIndex(old.id);
      } catch {
        /* ghost posting → reconcile */
      }
    }
  }
  const liveChunks = orphaned.length > 0
    ? existingChunks.filter(c => vectorIds.has(c.id))
    : existingChunks;
  const existingByHash = new Map(liveChunks.map(c => [c.contentHash, c]));

  // ── Global deduplication: проверяем contentHash во ВСЕХ sources, не только этом ──
  // Если chunk с таким же content уже есть в другом source — не дублируем.
  // Вместо этого link: этот source будет "видеть" chunk через searchKB.
  // Условие: dedup включается через LIA_KB_DEDUP=true (default: true для
  // single-user — нет смысла хранить одинаковые embeddings 2 раза).
  const dedupEnabled = process.env.LIA_KB_DEDUP !== 'false';
  let globallyReusedCount = 0;
  // P0-6 (C-KB-1): Set of chunk IDs that were globally reused.
  const globallyReusedIds = new Set<string>();
  if (dedupEnabled && chunks.length > 0) {
    const newHashes = chunks.map(c => c.contentHash);
    const globalMatches = await db.chunk.findMany({
      where: {
        contentHash: { in: newHashes },
        sourceId: { not: sourceId },  // exclude this source (already checked)
      },
      select: { id: true, contentHash: true, sourceId: true },
    });
    const globalByHash = new Map(globalMatches.map(c => [c.contentHash, c]));

    // Mark chunks that exist globally — we'll skip embedding for them
    // and create a "link" entry pointing to the existing chunk's vector.
    // For simplicity: just skip creating duplicate chunk, search will find
    // the original via contentHash match across sources.
    // P0-6 fix (C-KB-1): track globally-reused chunk IDs in a Set.
    for (const chunk of chunks) {
      if (globalByHash.has(chunk.contentHash) && !existingByHash.has(chunk.contentHash)) {
        chunk.id = globalByHash.get(chunk.contentHash)!.id;
        globallyReusedIds.add(chunk.id);
        globallyReusedCount++;
      }
    }
  }

  const reusableChunks: KbChunk[] = [];
  const chunksToEmbed: KbChunk[] = [];
  for (const chunk of chunks) {
    if (existingByHash.has(chunk.contentHash)) {
      reusableChunks.push(chunk);
    } else if (dedupEnabled && globallyReusedIds.has(chunk.id)) {
      // Globally reused — skip embedding (search finds original via hash)
      reusableChunks.push(chunk);
    } else {
      chunksToEmbed.push(chunk);
    }
  }

  const newHashes = new Set(chunks.map(c => c.contentHash));
  const chunksToDelete = liveChunks.filter(c => !newHashes.has(c.contentHash));

  logger.info('kb', 'Incremental reindex plan', {
    sourceId: sourceId.slice(0, 8),
    total: chunks.length,
    reusable: reusableChunks.length,
    toEmbed: chunksToEmbed.length,
    toDelete: chunksToDelete.length,
    globallyReused: globallyReusedCount,
  });

  for (const old of chunksToDelete) {
    // Порядок: сначала Prisma (если упадёт — векторы не трогаем, retry возможен),
    // потом better-sqlite3. Если better-sqlite3 падает после успешного Prisma —
    // chunk удалён, вектор остался → ghost vector. Lazy cleanup в search.ts
    // удалит его при первом обращении.
    try {
      await db.chunk.delete({ where: { id: old.id } });
    } catch (e) {
      // Prisma delete failed — chunk ещё есть в БД, не трогаем индексы
      logger.warn('kb', 'Failed to delete old chunk from Prisma (will retry next reindex)', {
        chunkId: old.id.slice(0, 8),
      }, e);
      continue;
    }
    try {
      deleteKbVector(old.id);
      removeFromInvertedIndex(old.id);
    } catch (e) {
      // Index delete failed — chunk удалён, но ghost vector остался.
      // Lazy cleanup в search.ts:184 / bm25.ts:258 удалит при первом обращении.
      logger.warn('kb', 'Failed to delete chunk indexes (ghost entry may remain, will be cleaned up on search)', {
        chunkId: old.id.slice(0, 8),
      }, e);
    }
  }

  for (const chunk of reusableChunks) {
    const existing = existingByHash.get(chunk.contentHash);
    if (!existing) continue;
    if (existing.position !== chunk.position || existing.parentId !== chunk.parentId) {
      await db.chunk.update({
        where: { id: existing.id },
        data: { position: chunk.position, parentId: chunk.parentId, metadata: JSON.stringify(chunk.metadata) },
      }).catch(() => null);
    }
  }

  for (const chunk of reusableChunks) {
    const existing = existingByHash.get(chunk.contentHash);
    if (existing) {
      chunk.id = existing.id;
    }
  }

  const chunksToProcess = chunksToEmbed;
  const BATCH_SIZE = KB_EMBED_BATCH_SIZE;

  if (chunksToProcess.length === 0 && chunksToDelete.length === 0) {
    logger.info('kb', 'No changes detected, skipping embedding entirely', {
      sourceId: sourceId.slice(0, 8),
    });
  }

  for (let i = 0; i < chunksToProcess.length; i += BATCH_SIZE) {
    if (controller.signal.aborted) throw new Error('aborted');

    const batch = chunksToProcess.slice(i, i + BATCH_SIZE);
    const totalToEmbed = chunksToProcess.length;

    emitProgress({
      phase: 'embedding',
      processed: i,
      total: totalToEmbed,
      percent: totalToEmbed === 0
        ? 90
        : Math.round(5 + (i / totalToEmbed) * 85),
    });

    const embeddings = await embedBatchForKb(batch.map(c => c.content));

    const toInsert: Array<{ chunk: KbChunk; embedding: Float32Array }> = [];

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const embedding = embeddings[j];

      if (!embedding) {
        logger.warn('kb', 'Skipping chunk with failed embedding', {
          sourceId: sourceId.slice(0, 8),
          chunkIndex: i + j,
          contentPreview: chunk.content.slice(0, 60),
        });
        continue;
      }

      toInsert.push({ chunk, embedding });
    }

    if (toInsert.length > 0) {
      await createChunksBatch(toInsert.map(({ chunk }) => chunk));

      for (const { chunk, embedding } of toInsert) {
        // Insert вектор + inverted index atomically по возможности.
        // Если любой из них падает — откатываем Prisma-запись этого чанка,
        // чтобы не осталось orphaned chunk (есть в БД, нет в векторном индексе).
        // При следующем reindex persistKbChunks не найдёт его по contentHash
        // (он удалён) → пересоздаст с вектором. Самоисцеление.
        try {
          insertKbVector({
            id: chunk.id,
            sourceId: chunk.sourceId,
            sourceType: sourceType as 'document' | 'url' | 'folder' | 'codebase',
            embedding,
          });

          addToInvertedIndex({
            chunkId: chunk.id,
            sourceId: chunk.sourceId,
            content: chunk.content,
          });
        } catch (idxErr) {
          logger.error('kb', 'insertKbVector/addToInvertedIndex failed, rolling back chunk write', {
            sourceId: sourceId.slice(0, 8),
            chunkId: chunk.id.slice(0, 8),
          }, idxErr);
          await rollbackChunkWrite(chunk.id);
          throw idxErr;
        }
      }
    }

    emitProgress({
      phase: 'inserting',
      processed: Math.min(i + BATCH_SIZE, chunks.length),
      total: chunks.length,
      percent: Math.round(5 + (Math.min(i + BATCH_SIZE, chunks.length) / chunks.length) * 90),
    });
  }

  return db.chunk.count({ where: { sourceId } });
}

/**
 * Manifest-only persist: BM25 inverted index, без embeddings (Ollama не вызывается).
 * Используется для folder sources — каталог имён/путей за секунды.
 *
 * Инкрементальный режим: сравнивает contentHash новых chunks с существующими.
 * Удаляет только отсутствующие, вставляет только новые, оставляет unchanged.
 * Это критично для folder sources с тысячами файлов — без инкрементальности
 * каждое reindex пересоздаёт все chunks (медленно) и в сочетании с
 * не-атомарным delete генерирует ghost entries.
 *
 * Folder sources не имеют kb_vec_virtual (manifest-only = без embeddings),
 * поэтому векторный индекс не трогается. Только Prisma Chunk + inverted index.
 */
export async function persistManifestChunks(params: {
  sourceId: string;
  chunks: KbChunk[];
  controller: AbortController;
  emitProgress: (p: Omit<IndexProgress, 'sourceId'>) => void;
}): Promise<number> {
  const { sourceId, chunks, controller, emitProgress } = params;

  emitProgress({ phase: 'parsing', processed: 0, total: chunks.length, percent: 5 });

  // ── Incremental diff через contentHash (как в persistKbChunks) ──
  const existingChunks = await db.chunk.findMany({
    where: { sourceId },
    select: { id: true, contentHash: true, position: true, parentId: true, metadata: true },
  });
  const existingByHash = new Map(existingChunks.map(c => [c.contentHash, c]));

  const chunksToInsert: KbChunk[] = [];
  const reusableChunks: KbChunk[] = [];
  for (const chunk of chunks) {
    if (existingByHash.has(chunk.contentHash)) {
      reusableChunks.push(chunk);
    } else {
      chunksToInsert.push(chunk);
    }
  }

  // Найти chunks которые нужно удалить (были раньше, сейчас нет в новом списке)
  const newHashes = new Set(chunks.map(c => c.contentHash));
  const chunksToDelete = existingChunks.filter(c => !newHashes.has(c.contentHash));

  logger.info('kb', 'Incremental manifest reindex plan', {
    sourceId: sourceId.slice(0, 8),
    total: chunks.length,
    reusable: reusableChunks.length,
    toInsert: chunksToInsert.length,
    toDelete: chunksToDelete.length,
  });

  // Если ничего не изменилось — early return (экономим seconds на больших папках)
  if (chunksToInsert.length === 0 && chunksToDelete.length === 0) {
    logger.info('kb', 'No changes in manifest, skipping', { sourceId: sourceId.slice(0, 8) });
    return chunks.length;
  }

  // Удалить отсутствующие chunks
  for (const old of chunksToDelete) {
    try {
      await db.chunk.delete({ where: { id: old.id } });
    } catch (e) {
      logger.warn('kb', 'Failed to delete old manifest chunk from Prisma', {
        chunkId: old.id.slice(0, 8),
      }, e);
      continue;
    }
    try {
      removeFromInvertedIndex(old.id);
    } catch (e) {
      logger.warn('kb', 'Failed to delete manifest chunk from inverted index (ghost may remain)', {
        chunkId: old.id.slice(0, 8),
      }, e);
    }
  }

  // Обновить position/parentId для reusable chunks (если порядок изменился)
  for (const chunk of reusableChunks) {
    const existing = existingByHash.get(chunk.contentHash);
    if (!existing) continue;
    if (existing.position !== chunk.position || existing.parentId !== chunk.parentId) {
      await db.chunk.update({
        where: { id: existing.id },
        data: { position: chunk.position, parentId: chunk.parentId, metadata: JSON.stringify(chunk.metadata) },
      }).catch(() => null);
    }
  }

  // Вставить новые chunks
  const BATCH_SIZE = 50;

  for (let i = 0; i < chunksToInsert.length; i += BATCH_SIZE) {
    if (controller.signal.aborted) throw new Error('aborted');

    const batch = chunksToInsert.slice(i, i + BATCH_SIZE);

    await createChunksBatch(batch);

    for (const chunk of batch) {
      try {
        addToInvertedIndex({
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          content: chunk.content,
        });
      } catch (e) {
        logger.error('kb', 'Manifest chunk index insert failed, rolling back Prisma chunk', {
          sourceId: sourceId.slice(0, 8),
          chunkId: chunk.id.slice(0, 8),
        }, e);
        await db.chunk.delete({ where: { id: chunk.id } }).catch(() => null);
        throw e;
      }
    }

    emitProgress({
      phase: 'inserting',
      processed: Math.min(i + BATCH_SIZE, chunksToInsert.length),
      total: chunksToInsert.length,
      percent: Math.round((Math.min(i + BATCH_SIZE, chunksToInsert.length) / Math.max(chunksToInsert.length, 1)) * 100),
    });

    // Yield event loop — API остаётся отзывчивым во время больших папок.
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  return db.chunk.count({ where: { sourceId } });
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Запустить индексацию document source.
 *
 * Pipeline:
 *   1. Загрузить Source из БД
 *   2. Проверить что файл существует и доступен для чтения
 *   3. Parse → markdown
 *   4. Chunk через DocumentChunker
 *   5. Delete old chunks + kb_vec_virtual entries
 *   6. Batch embed + insert (8 за раз)
 *   7. Update Source.status = 'ready'
 *
 * AbortController: если для sourceId уже идёт индексация — отменяем её
 * (abort + удаляем controller), затем запускаем новую.
 *
 * Error handling: при ошибке (включая abort) — Source.status = 'error',
 * errorMessage сохраняется. При abort — отдельно помечаем как 'idle' (не 'error'),
 * т.к. это намеренное действие пользователя.
 *
 * @throws никогда не бросает — все ошибки ловятся и записываются в Source
 */
export async function indexDocumentSource(sourceId: string): Promise<void> {
  // P-CORE-19 fix: serialize concurrent reindex calls per source. We wait
  // for any previous run, THEN register our own mutex promise, THEN run.
  // The mutex promise resolves in our finally block — so the NEXT caller's
  // waitForIndexing() will block until we're done.
  await waitForIndexing(sourceId);
  let resolveMutex!: () => void;
  const runPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
  setIndexingMutex(sourceId, runPromise);
  try {
    await _indexDocumentSourceImpl(sourceId);
  } finally {
    clearIndexingMutex(sourceId);
    resolveMutex();
  }
}

async function _indexDocumentSourceImpl(sourceId: string): Promise<void> {
  // P-CORE-19 fix: waitForIndexing is called by the outer indexDocumentSource.
  const controller = acquireIndexingController(sourceId);

  const emitProgress = (p: Omit<IndexProgress, 'sourceId'>) => {
    const event: IndexProgress = { sourceId, ...p };
    indexEvents.emit('progress', event);
  };

  try {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source || source.type !== 'document') {
      throw new Error(`Source ${sourceId} not found or not a document`);
    }

    const config = JSON.parse(source.config) as DocumentSourceConfig;

    // ── File-level contentHash check ──
    // Если файл не изменился с последней индексации — skip весь pipeline.
    // SHA-256 файла сравнивается с config.contentHash. Если совпадает и
    // source.status='ready' — ничего не делаем. Это экономит seconds-minutes
    // на больших PDF/DOCX при false-positive chokidar events (git checkout,
    // touch, backup-touch).
    //
    // G21: НЕ пишем contentHash в DB до успешного persist — иначе crash в окне
    // ready+newHash оставляет старые чанки и навсегда скипает reindex.
    // Новый hash держим в pendingFileHash и коммитим только вместе со status=ready.
    //
    // Только для статичных файлов (.md, .txt, .pdf, .docx). Не для URL
    // (контент может измениться без изменения URL).
    let pendingFileHash: string | undefined;
    if (config.contentHash && source.status === 'ready') {
      try {
        const fileBuffer = await readFile(config.filePath);
        const currentHash = sha256Buffer(fileBuffer);
        if (currentHash === config.contentHash) {
          const vecCount = countKbVectorsForSource(sourceId);
          if (vecCount > 0 && vecCount >= source.chunkCount) {
            logger.info('kb', 'File unchanged, skipping reindex', {
              sourceId: sourceId.slice(0, 8),
              fileHash: currentHash.slice(0, 8),
              vecCount,
            });
            emitProgress({
              phase: 'done',
              processed: source.chunkCount,
              total: source.chunkCount,
              percent: 100,
            });
            return;
          }
          logger.info('kb', 'File unchanged but vectors incomplete — forcing re-embed', {
            sourceId: sourceId.slice(0, 8),
            fileHash: currentHash.slice(0, 8),
            chunkCount: source.chunkCount,
            vecCount,
          });
        } else {
          pendingFileHash = currentHash;
          logger.info('kb', 'File changed, will reindex', {
            sourceId: sourceId.slice(0, 8),
            oldHash: config.contentHash.slice(0, 8),
            newHash: currentHash.slice(0, 8),
          });
        }
      } catch (hashErr) {
        // Если не можем прочитать файл для hash check — продолжаем, даст
        // осмысленную ошибку на шаге parseKbFile ниже.
        logger.warn('kb', 'File hash check failed, will proceed with full reindex', {
          sourceId: sourceId.slice(0, 8),
        }, hashErr);
      }
    }

    await db.source.update({
      where: { id: sourceId },
      data: { status: 'indexing', errorMessage: null },
    });

    emitProgress({ phase: 'parsing', processed: 0, total: 0, percent: 0 });

    const markdown = await parseKbFile(config.filePath, config.mimeType, controller.signal);

    if (controller.signal.aborted) throw new Error('aborted');

    emitProgress({ phase: 'chunking', processed: 0, total: 0, percent: 5 });
    const chunker = new DocumentChunker();
    const chunks = chunker.chunk(markdown, sourceId);

    if (chunks.length === 0) {
      throw new Error('Document is empty or could not be parsed');
    }

    logger.info('kb', 'Document chunked', {
      sourceId: sourceId.slice(0, 8),
      chunkCount: chunks.length,
      totalChars: markdown.length,
    });

    const finalChunkCount = await persistKbChunks({
      sourceId,
      sourceType: source.type,
      chunks,
      controller,
      emitProgress,
    });

    await db.source.update({
      where: { id: sourceId },
      data: {
        status: 'ready',
        lastIndexedAt: new Date(),
        chunkCount: finalChunkCount,
        errorMessage: null,
        // G21: contentHash только после успешного persist (вместе со status=ready).
        config: JSON.stringify({
          ...config,
          contentHash:
            pendingFileHash
            ?? config.contentHash
            ?? sha256Buffer(await readFile(config.filePath)),
        }),
      },
    });

    emitProgress({
      phase: 'done',
      processed: finalChunkCount,
      total: finalChunkCount,
      percent: 100,
    });

    logger.info('kb', 'Document indexed', {
      sourceId: sourceId.slice(0, 8),
      chunkCount: finalChunkCount,
    });
  } catch (e) {
    await finalizeIndexingError(sourceId, e, emitProgress, 'Document indexing');
  } finally {
    releaseIndexingController(sourceId);
  }
}

// ============================================================================
// File parsers
// ============================================================================

/** Parse KB file → markdown (exported for folder indexer). */
export async function parseKbFile(
  filePath: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<string> {
  return parseFile(filePath, mimeType, signal);
}

/**
 * Parse file → markdown string.
 *
 * Phase 2: .md / .txt — native (read as UTF-8)
 * Phase 7: .pdf (pdf-parse v2), .docx (mammoth)
 *
 * @throws Error если файл не существует, не читается, или mimeType не поддерживается
 */
async function parseFile(
  filePath: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // ── Markdown / plain text — native ──
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') {
    const content = await readFile(filePath, 'utf-8');
    if (signal.aborted) throw new Error('aborted');
    return content;
  }

  // ── PDF — pdf-parse v2 (Phase 7) ──
  if (mimeType === 'application/pdf') {
    const buffer = await readFile(filePath);
    if (signal.aborted) throw new Error('aborted');

    // pdf-parse v2: class-based API
    // new PDFParse({ data: buffer }).getText() — internally calls load()
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    const textResult = await parser.getText();
    if (signal.aborted) throw new Error('aborted');

    // textResult имеет .text (string) и .pages (array per-page)
    const text = textResult.text ?? '';
    if (text.trim().length === 0) {
      throw new Error('PDF contains no extractable text (possibly scanned image PDF)');
    }

    logger.info('kb', 'PDF parsed', {
      pages: textResult.pages?.length ?? 0,
      textLength: text.length,
    });
    return text;
  }

  // ── DOCX — mammoth (Phase 7) ──
  // mammoth конвертирует DOCX → HTML, потом мы конвертируем HTML → markdown-like text
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    const buffer = await readFile(filePath);
    if (signal.aborted) throw new Error('aborted');

    const mammoth = await import('mammoth');
    // convertToHtml возвращает { value: html, messages }
    const result = await mammoth.convertToHtml({ buffer });

    if (signal.aborted) throw new Error('aborted');

    // Простая HTML → text конверсия:
    // - <h1>-<h6> → Markdown headings (для DocumentChunker)
    // - <p> → paragraph (двойной \n)
    // - <strong>/<b> → **text**
    // - <em>/<i> → *text*
    // - <ul><li> → "- item"
    // - <ol><li> → "1. item"
    // - <br> → \n
    // Это не полный HTML parser, но достаточно для DOCX structure
    const markdown = htmlToMarkdown(result.value);

    if (markdown.trim().length === 0) {
      throw new Error('DOCX contains no extractable text');
    }

    logger.info('kb', 'DOCX parsed', {
      htmlLength: result.value.length,
      markdownLength: markdown.length,
      warnings: result.messages.length,
    });
    return markdown;
  }

  throw new Error(
    `Unsupported mimeType: ${mimeType}. Supported: text/markdown, text/plain, ` +
    `application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX).`,
  );
}

/**
 * Простая HTML → Markdown конверсия для DOCX parser output.
 *
 * mammoth возвращает HTML, но нам нужен text с structure для DocumentChunker.
 * Не используем полноценный HTML parser (turndown) чтобы избежать лишней
 * зависимости — DOCX structure простая (headings, paragraphs, lists).
 *
 * Поддерживает: h1-h6, p, strong/b, em/i, ul/ol/li, br, tables (как text).
 */
function htmlToMarkdown(html: string): string {
  // Удаляем HTML comments
  let text = html.replace(/<!--[\s\S]*?-->/g, '');

  // Headings: <h1>...</h1> → # ...
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    return `\n${'#'.repeat(parseInt(level))} ${stripTags(content).trim()}\n\n`;
  });

  // Bold: <strong>/<b> → **text**
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');

  // Italic: <em>/<i> → *text*
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // Unordered list: <ul><li>...</li></ul> → "- item\n"
  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const items = content.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return items.map((item: string) => `- ${stripTags(item).trim()}`).join('\n') + '\n\n';
  });

  // Ordered list: <ol><li>...</li></ol> → "1. item\n"
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    const items = content.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return items.map((item: string, i: number) => `${i + 1}. ${stripTags(item).trim()}`).join('\n') + '\n\n';
  });

  // Paragraphs: <p>...</p> → content + \n\n
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // <br> → \n
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Table cells → tab-separated (упрощённо, для text extraction)
  text = text.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, '$1\t');
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n');
  text = text.replace(/<\/?(table|thead|tbody|th)[^>]*>/gi, '');

  // Remove remaining tags
  text = stripTags(text);

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalize whitespace: multiple blank lines → double newline
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/** Remove all HTML tags, keep text content */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// ============================================================================
// File upload helper — сохраняет загруженный файл в kb-uploads dir
// ============================================================================

/**
 * Сохранить содержимое файла (Buffer) в kb-uploads директорию.
 *
 * Создаёт директорию если не существует. Возвращает абсолютный путь к файлу.
 *
 * Filename sanitize через sanitizeFilename() из paths.ts — предотвращает
 * path traversal через имя файла.
 *
 * @param originalFilename  имя файла от клиента (НЕ используется как путь — только как fallback)
 * @param content           содержимое файла
 * @returns абсолютный путь к сохранённому файлу
 */
export async function saveUploadedFile(
  originalFilename: string,
  content: Buffer,
): Promise<{ filePath: string; contentHash: string; fileSize: number }> {
  const uploadDir = path.join(PATHS.artifacts, 'kb-uploads');
  await mkdir(uploadDir, { recursive: true });

  // Sanitize filename — strip path separators, lowercase, etc.
  const { sanitizeFilename } = await import('@/lib/paths');
  const safeName = sanitizeFilename(originalFilename);

  // Add timestamp + random suffix to avoid collisions
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const uniqueName = `${timestamp}-${random}-${safeName}`;

  const filePath = path.join(uploadDir, uniqueName);
  await import('fs/promises').then(fs => fs.writeFile(filePath, content));

  return {
    filePath,
    contentHash: sha256Buffer(content),
    fileSize: content.length,
  };
}

// ============================================================================
// URL indexer — fetch веб-страницы + extract content через Readability (Phase 7)
// ============================================================================

/**
 * Index a URL source: fetch page → extract main content → chunk → embed.
 *
 * Pipeline:
 *   1. Fetch URL (с SSRF protection)
 *   2. Parse HTML через jsdom
 *   3. Extract main content через @mozilla/readability
 *   4. Convert to markdown-like text
 *   5. Chunk + embed (reuse document indexing logic)
 *
 * @param sourceId  Source.id с type='url'
 */
export async function indexUrlSource(sourceId: string): Promise<void> {
  // P-CORE-19 fix: per-source mutex — see acquireIndexingController.
  // Also P-CORE-20 fix: previously duplicated the acquire/release logic inline
  // instead of using acquireIndexingController/releaseIndexingController, so
  // the mutex never applied to URL sources and /cancel couldn't see them.
  await waitForIndexing(sourceId);
  let resolveMutex!: () => void;
  const runPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
  setIndexingMutex(sourceId, runPromise);
  try {
    await _indexUrlSourceImpl(sourceId);
  } finally {
    clearIndexingMutex(sourceId);
    resolveMutex();
  }
}

async function _indexUrlSourceImpl(sourceId: string): Promise<void> {
  // P-CORE-19 fix: waitForIndexing is called by the outer indexUrlSource.
  const controller = acquireIndexingController(sourceId);

  const emitProgress = (p: Omit<IndexProgress, 'sourceId'>) => {
    indexEvents.emit('progress', { sourceId, ...p });
  };

  try {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source || source.type !== 'url') {
      throw new Error(`Source ${sourceId} not found or not a url source`);
    }

    const config = JSON.parse(source.config) as { url: string; contentHash?: string; title?: string };

    await db.source.update({
      where: { id: sourceId },
      data: { status: 'indexing', errorMessage: null },
    });

    emitProgress({ phase: 'parsing', processed: 0, total: 0, percent: 0 });

    // 1. Fetch URL с SSRF protection.
    // P0-7 fix (C-KB-2): manual redirect handling with SSRF re-check on each hop.
    // Previous code used `redirect: 'follow'` — fetch silently followed 3xx
    // redirects to ANY target, including AWS metadata (169.254.169.254).
    const { assertSafeUrl } = await import('@/lib/infra/ssrf');

    const MAX_REDIRECTS = 5;
    let currentUrl = (await assertSafeUrl(config.url)).toString();
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (controller.signal.aborted) throw new Error('aborted');
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Lia-KB-Indexer/1.0 (knowledge base document fetcher)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const locationHeader = response.headers.get('location');
        if (!locationHeader) {
          throw new Error(`Redirect ${response.status} without Location header`);
        }
        const nextUrl = new URL(locationHeader, currentUrl).toString();
        const safeNext = await assertSafeUrl(nextUrl);
        currentUrl = safeNext.toString();
        if (hop === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        }
        continue;
      }
      break;
    }

    if (!response) throw new Error('Fetch produced no response');
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText} (final URL: ${currentUrl})`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`URL returned non-HTML content: ${contentType}`);
    }

    const html = await response.text();
    if (controller.signal.aborted) throw new Error('aborted');

    emitProgress({ phase: 'parsing', processed: 0, total: 0, percent: 10 });

    // 2. Parse HTML через jsdom + extract через Readability
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');

    const doc = new JSDOM(html, { url: config.url });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (!article || !article.textContent?.trim()) {
      throw new Error('Readability could not extract main content (page may be JS-rendered or empty)');
    }

    if (controller.signal.aborted) throw new Error('aborted');

    // 3. Build markdown-like text: title + content
    const title = article.title ?? source.name;
    const markdown = `# ${title}\n\nSource: ${config.url}\n\n${article.textContent}`;

    // ── Content-level dedup: если contentHash не изменился — skip весь pipeline ──
    // Сравниваем SHA-256 нового markdown с config.contentHash. Если совпадает
    // и source.status='ready' — ничего не делаем (страница не обновилась).
    // Экономит HTTP fetch + chunking + embedding для статичных страниц.
    const newContentHash = sha256(markdown);
    if (config.contentHash === newContentHash && source.status === 'ready') {
      logger.info('kb', 'URL content unchanged, skipping reindex', {
        sourceId: sourceId.slice(0, 8),
        url: config.url,
        contentHash: newContentHash.slice(0, 8),
      });
      emitProgress({
        phase: 'done',
        processed: source.chunkCount,
        total: source.chunkCount,
        percent: 100,
      });
      // Status was set to 'indexing' before fetch — restore ready on no-op reindex.
      await db.source.update({
        where: { id: sourceId },
        data: { status: 'ready' },
      }).catch(() => null);
      return;
    }

    // Metadata without contentHash — G21: hash only after successful persist
    // (final ready update below). Writing hash early + crash mid-index leaves
    // a new hash with old/partial chunks.
    const updatedConfig = {
      ...config,
      title,
      contentLength: article.textContent.length,
      fetchedAt: new Date().toISOString(),
    };
    await db.source.update({
      where: { id: sourceId },
      data: { config: JSON.stringify(updatedConfig) },
    });

    emitProgress({ phase: 'chunking', processed: 0, total: 0, percent: 20 });

    // 4. Chunk + embed — reuse document indexing logic
    const chunker = new DocumentChunker();
    const chunks = chunker.chunk(markdown, sourceId);

    if (chunks.length === 0) {
      throw new Error('Extracted content is empty after chunking');
    }

    // Incremental reindex (same as document indexer)
    const existingChunks = await db.chunk.findMany({
      where: { sourceId },
      select: { id: true, contentHash: true, position: true, parentId: true },
    });
    const existingByHash = new Map(existingChunks.map(c => [c.contentHash, c]));
    const newHashes = new Set(chunks.map(c => c.contentHash));
    const chunksToDelete = existingChunks.filter(c => !newHashes.has(c.contentHash));

    for (const old of chunksToDelete) {
      try {
        await db.chunk.delete({ where: { id: old.id } });
      } catch (e) {
        logger.warn('kb', 'Failed to delete old URL chunk from Prisma (will retry next reindex)', {
          chunkId: old.id.slice(0, 8),
        }, e);
        continue;
      }
      try {
        deleteKbVector(old.id);
        removeFromInvertedIndex(old.id);
      } catch (e) {
        logger.warn('kb', 'Failed to delete URL chunk indexes (ghost entry may remain)', {
          chunkId: old.id.slice(0, 8),
        }, e);
      }
    }

    const chunksToEmbed = chunks.filter(c => !existingByHash.has(c.contentHash));

    logger.info('kb', 'URL content extracted', {
      sourceId: sourceId.slice(0, 8),
      url: config.url,
      title,
      contentLength: article.textContent.length,
      chunkCount: chunks.length,
      toEmbed: chunksToEmbed.length,
    });

    // 5. Batch embed + insert
    const BATCH_SIZE = KB_EMBED_BATCH_SIZE;
    for (let i = 0; i < chunksToEmbed.length; i += BATCH_SIZE) {
      if (controller.signal.aborted) throw new Error('aborted');

      const batch = chunksToEmbed.slice(i, i + BATCH_SIZE);
      emitProgress({
        phase: 'embedding',
        processed: i,
        total: chunksToEmbed.length,
        percent: 20 + Math.round((i / Math.max(chunksToEmbed.length, 1)) * 75),
      });

      const embeddings = await embedBatchForKb(batch.map(c => c.content));

      const toInsert: Array<{
        chunk: (typeof batch)[number];
        embedding: Float32Array;
      }> = [];

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];
        if (!embedding) continue;
        toInsert.push({ chunk, embedding });
      }

      if (toInsert.length > 0) {
        await createChunksBatch(toInsert.map(({ chunk }) => chunk));

        for (const { chunk, embedding } of toInsert) {
          // Same rollback pattern as persistKbChunks — see comments there
          try {
            insertKbVector({
              id: chunk.id,
              sourceId: chunk.sourceId,
              sourceType: 'url',
              embedding,
            });

            addToInvertedIndex({
              chunkId: chunk.id,
              sourceId: chunk.sourceId,
              content: chunk.content,
            });
          } catch (idxErr) {
            logger.error('kb', 'URL chunk index insert failed, rolling back chunk write', {
              sourceId: sourceId.slice(0, 8),
              chunkId: chunk.id.slice(0, 8),
            }, idxErr);
            await rollbackChunkWrite(chunk.id);
            throw idxErr;
          }
        }
      }
    }

    const finalChunkCount = await db.chunk.count({ where: { sourceId } });
    await db.source.update({
      where: { id: sourceId },
      data: {
        status: 'ready',
        lastIndexedAt: new Date(),
        chunkCount: finalChunkCount,
        errorMessage: null,
        // G21: commit contentHash only with successful ready status
        config: JSON.stringify({
          ...updatedConfig,
          contentHash: newContentHash,
        }),
      },
    });

    emitProgress({ phase: 'done', processed: finalChunkCount, total: finalChunkCount, percent: 100 });
    logger.info('kb', 'URL indexed', {
      sourceId: sourceId.slice(0, 8),
      chunkCount: finalChunkCount,
    });
  } catch (e) {
    await finalizeIndexingError(sourceId, e, emitProgress, 'URL indexing');
  } finally {
    releaseIndexingController(sourceId);
  }
}
