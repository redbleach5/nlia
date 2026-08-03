import 'server-only';

// ============================================================================
// Hybrid search — vector + BM25 + RRF fusion.
// ============================================================================
//
// Pipeline:
//   1. Vector search через kb_vec_virtual (pre-filter by source_id, source_type)
//   2. JS BM25 keyword search (для точных терминов: error codes, ticket IDs)
//   3. Reciprocal Rank Fusion — объединение двух ранжированных списков
//   4. Apply metadata filters (state, assignee, etc.) — post-filter
//   5. Enrich with source info (name, type, citation)
//
// Graceful degradation: если vector search падает — fallback на BM25-only,
// если BM25 падает — fallback на vector-only, если оба падают — [].

import { embedForKb } from './embed';
import { searchKbVectors } from './db-vec-kb';
import { bm25Search } from './bm25';
import { rrf } from './rrf';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { SearchResult, SourceType, ChunkMetadata } from './types';

// P-CORE-22 fix: dedup Set for ghost vector cleanup. Prevents N concurrent
// searches from each scheduling cleanup for the same chunk IDs.
const ghostCleanupInFlight = new Set<string>();

// ============================================================================
// Public API
// ============================================================================

export interface SearchParams {
  query: string;
  sourceTypes?: SourceType[];
  sourceIds?: string[];
  // Filter by source tags (user-defined categories).
  // Source must have ALL specified tags (AND logic) for match.
  sourceTags?: string[];
  headingContains?: string;
  limit?: number;
}

/**
 * Streaming KB search — AsyncGenerator для прогресса.
 *
 * Возвращает события по мере выполнения:
 *   { phase: 'vector', hits: SearchResult[] }      — vector search done
 *   { phase: 'bm25', hits: SearchResult[] }        — BM25 search done
 *   { phase: 'done', hits: SearchResult[] }        — final results
 *
 * Для UI: показывает прогресс «vector search… → BM25… → done».
 * Для agent: tool result стримится, модель видит top hits раньше.
 *
 * Если streaming не нужен — используй searchKB() (non-streaming).
 */
export async function* searchKBStream(params: SearchParams): AsyncGenerator<{
  phase: 'vector' | 'bm25' | 'done';
  hits: SearchResult[];
  metadata?: { count: number; phaseMs?: number };
}> {
  const limit = params.limit ?? 10;

  // Tag filter (same as searchKB)
  let effectiveSourceIds = params.sourceIds;
  if (params.sourceTags && params.sourceTags.length > 0) {
    try {
      const allSources = await db.source.findMany({
        where: { status: 'ready' },
        select: { id: true, tags: true },
      });
      const matchingSourceIds = allSources
        .filter(s => {
          try {
            const tags = JSON.parse(s.tags) as string[];
            return params.sourceTags!.every(tag => tags.includes(tag));
          } catch { return false; }
        })
        .map(s => s.id);
      if (effectiveSourceIds && effectiveSourceIds.length > 0) {
        const existingSet = new Set(effectiveSourceIds);
        effectiveSourceIds = matchingSourceIds.filter(id => existingSet.has(id));
      } else {
        effectiveSourceIds = matchingSourceIds;
      }
      if (effectiveSourceIds.length === 0) {
        yield { phase: 'done', hits: [], metadata: { count: 0 } };
        return;
      }
    } catch (e) {
      logger.warn('kb', 'Tag filter in stream failed (non-fatal)', {}, e);
    }
  }

  // Vector search
  const vectorStart = Date.now();
  const vectorHits = await vectorSearch({ ...params, sourceIds: effectiveSourceIds }).catch((e) => {
    logger.warn('kb', 'Vector search in stream failed', {}, e);
    return [] as SearchResult[];
  });
  yield { phase: 'vector', hits: vectorHits, metadata: { count: vectorHits.length, phaseMs: Date.now() - vectorStart } };

  // BM25 search
  const bm25Start = Date.now();
  const bm25Hits = await bm25Search({
    query: params.query,
    sourceTypes: params.sourceTypes,
    sourceIds: effectiveSourceIds,
    limit: 30,
  }).catch((e) => {
    logger.warn('kb', 'BM25 search in stream failed', {}, e);
    return [] as SearchResult[];
  });
  yield { phase: 'bm25', hits: bm25Hits, metadata: { count: bm25Hits.length, phaseMs: Date.now() - bm25Start } };

  if (vectorHits.length === 0 && bm25Hits.length === 0) {
    yield { phase: 'done', hits: [], metadata: { count: 0 } };
    return;
  }

  // RRF fusion
  const fused = rrf([vectorHits, bm25Hits]);

  // Metadata filters
  const filtered = fused.filter(r => {
    if (params.headingContains) {
      const meta = r.metadata as Partial<{ heading?: string }>;
      const heading = meta.heading?.toLowerCase() ?? '';
      if (!heading.includes(params.headingContains.toLowerCase())) return false;
    }
    return true;
  });

  const ranked = filtered;

  const topResults = ranked.slice(0, limit);
  const enriched = await enrichWithSourceInfo(topResults);

  yield { phase: 'done', hits: enriched, metadata: { count: enriched.length } };
}

/**
 * Гибридный поиск по Knowledge Base.
 *
 * Объединяет векторный поиск (семантика) и BM25 (точные термины) через RRF.
 *
 * @returns массив SearchResult, отсортированный по убыванию fused score.
 *          Каждый результат содержит content, metadata, source info, citation.
 *
 * Error handling: graceful degradation — если один из этапов падает,
 * используем оставшиеся. Если все падают — возвращаем [].
 */
export async function searchKB(params: SearchParams): Promise<SearchResult[]> {
  const limit = params.limit ?? 10;

  // ── Tag filter: находим sourceIds с matching tags ──
  // Tags хранятся в Source.tags как JSON array. Если sourceTags задан —
  // фильтруем sources и используем их IDs в дополнение к sourceIds.
  let effectiveSourceIds = params.sourceIds;
  if (params.sourceTags && params.sourceTags.length > 0) {
    try {
      const allSources = await db.source.findMany({
        where: { status: 'ready' },
        select: { id: true, tags: true },
      });
      const matchingSourceIds = allSources
        .filter(s => {
          try {
            const tags = JSON.parse(s.tags) as string[];
            return params.sourceTags!.every(tag => tags.includes(tag));
          } catch {
            return false;
          }
        })
        .map(s => s.id);

      if (effectiveSourceIds && effectiveSourceIds.length > 0) {
        // Intersect: source must match BOTH sourceIds AND sourceTags
        const existingSet = new Set(effectiveSourceIds);
        effectiveSourceIds = matchingSourceIds.filter(id => existingSet.has(id));
      } else {
        effectiveSourceIds = matchingSourceIds;
      }

      if (effectiveSourceIds.length === 0) {
        // No sources match tags — return empty early
        return [];
      }
    } catch (e) {
      logger.warn('kb', 'Tag filter failed (non-fatal), continuing without tags', {}, e);
    }
  }

  // Параллельно запускаем vector и BM25 search
  const searchParams = { ...params, sourceIds: effectiveSourceIds };
  const [vectorHits, bm25Hits] = await Promise.all([
    vectorSearch(searchParams).catch((e) => {
      logger.warn('kb', 'Vector search failed, falling back to BM25-only', {}, e);
      return [] as SearchResult[];
    }),
    bm25Search({
      query: params.query,
      sourceTypes: params.sourceTypes,
      sourceIds: effectiveSourceIds,
      limit: 30,
    }).catch((e) => {
      logger.warn('kb', 'BM25 search failed, falling back to vector-only', {}, e);
      return [] as SearchResult[];
    }),
  ]);

  if (vectorHits.length === 0 && bm25Hits.length === 0) {
    return [];
  }

  // RRF fusion
  const fused = rrf([vectorHits, bm25Hits]);

  // Apply metadata filters (post-filter на fused результате)
  const filtered = fused.filter(r => {
    if (params.headingContains) {
      const meta = r.metadata as Partial<{ heading?: string }>;
      const heading = meta.heading?.toLowerCase() ?? '';
      if (!heading.includes(params.headingContains.toLowerCase())) return false;
    }
    return true;
  });

  const ranked = filtered;

  // Trim to limit и enrich с source info (если ещё не enriched)
  const topResults = ranked.slice(0, limit);
  let enriched = await enrichWithSourceInfo(topResults);

  // Manifest fallback: идентификатор в теле документа (EGTS_SR_ADAS_DATA), не в имени файла
  try {
    const { shouldProbeFolderContent, probeFolderContentByQuery } = await import('./folder-content-probe');
    if (shouldProbeFolderContent(params.query, enriched)) {
      const probed = await probeFolderContentByQuery(params.query, { limit: Math.min(limit, 2) });
      if (probed.length > 0) {
        enriched = probed;
      }
    }
  } catch (e) {
    logger.warn('kb', 'Folder content probe failed (non-fatal)', {}, e);
  }

  return enriched;
}

// ============================================================================
// Internal — vector search wrapper
// ============================================================================

async function vectorSearch(params: SearchParams): Promise<SearchResult[]> {
  const queryEmbedding = await embedForKb(params.query);
  const hits = await searchKbVectors({
    embedding: queryEmbedding,
    topK: 50,
    sourceTypes: params.sourceTypes,
    sourceIds: params.sourceIds,
  });

  if (hits.length === 0) return [];

  // Загружаем полные данные chunks из Prisma
  const chunkIds = hits.map(h => h.id);
  const chunks = await db.chunk.findMany({
    where: { id: { in: chunkIds } },
    select: {
      id: true,
      content: true,
      metadata: true,
      sourceId: true,
      source: { select: { type: true, name: true } },
    },
  });

  // Сохраняем ordering по similarity из vectorHits
  const chunkMap = new Map(chunks.map(c => [c.id, c]));
  const results: SearchResult[] = [];
  const ghostChunkIds: string[] = [];
  for (const hit of hits) {
    const chunk = chunkMap.get(hit.id);
    if (!chunk) {
      // Ghost vector — chunk удалён в Prisma, но вектор остался в kb_vec_virtual.
      // Собираем для lazy cleanup (одно batch-удаление вместо N отдельных).
      ghostChunkIds.push(hit.id);
      continue;
    }

    let metadata: ChunkMetadata;
    try {
      metadata = JSON.parse(chunk.metadata) as ChunkMetadata;
    } catch {
      metadata = { isComment: false } as ChunkMetadata;
    }

    results.push({
      id: chunk.id,
      sourceId: chunk.sourceId,
      content: chunk.content,
      metadata,
      score: hit.similarity,
      matchType: 'vector',
      sourceName: chunk.source.name,
      sourceType: chunk.source.type as SourceType,
    });
  }

  // Lazy cleanup: удаляем ghost vectors fire-and-forget. Не блокируем search.
  // P-CORE-22 fix: previously each ghost had its own `setImmediate` → `import`
  // → `deleteKbVector` transaction. N concurrent searches with M ghosts each
  // meant N×M separate transactions racing on the same IDs. Now we batch all
  // ghosts into a single `deleteKbVectorsBatch` call (one transaction per 500
  // IDs), deduplicate via a module-level in-flight Set to avoid re-scheduling
  // cleanup for IDs that are already being cleaned, and LOG errors instead of
  // swallowing them.
  if (ghostChunkIds.length > 0) {
    // Deduplicate against in-flight cleanup.
    const toClean = ghostChunkIds.filter(id => !ghostCleanupInFlight.has(id));
    if (toClean.length > 0) {
      for (const id of toClean) ghostCleanupInFlight.add(id);
      logger.warn('kb', `Detected ${ghostChunkIds.length} ghost vector(s) — scheduling lazy cleanup`, {
        sample: ghostChunkIds.slice(0, 3),
        scheduled: toClean.length,
        alreadyInFlight: ghostChunkIds.length - toClean.length,
      });
      setImmediate(() => {
        import('./db-vec-kb').then(({ deleteKbVectorsBatch }) => {
          try {
            const deleted = deleteKbVectorsBatch(toClean);
            logger.info('kb', `Ghost cleanup: deleted ${deleted} vector row(s)`, { requested: toClean.length });
          } catch (e) {
            logger.warn('kb', `Ghost cleanup failed for ${toClean.length} ID(s)`, { sample: toClean.slice(0, 3) }, e);
          } finally {
            for (const id of toClean) ghostCleanupInFlight.delete(id);
          }
        }).catch((e) => {
          logger.warn('kb', 'Ghost cleanup: dynamic import of db-vec-kb failed', {}, e);
          for (const id of toClean) ghostCleanupInFlight.delete(id);
        });
      });
    }
  }

  return results;
}

// ============================================================================
// Internal — enrich with citation
// ============================================================================

/**
 * Заполнить citation для каждого результата.
 *
 * Citation — короткая форма для inline-упоминания в ответе Лии:
 *   - Document / URL: "SourceName > Heading" (если есть heading)
 *   - Folder: "SourceName > relativePath > Heading"
 *   - Если нет heading: "SourceName"
 */
async function enrichWithSourceInfo(results: SearchResult[]): Promise<SearchResult[]> {
  return results.map(r => {
    let citation: string;

    if (r.sourceType === 'folder') {
      const meta = r.metadata as { relativePath?: string; heading?: string };
      const rel = meta.relativePath ?? '';
      const heading = meta.heading;
      citation = heading
        ? `${r.sourceName ?? 'Source'} > ${rel} > ${heading}`
        : rel
          ? `${r.sourceName ?? 'Source'} > ${rel}`
          : (r.sourceName ?? 'Source');
    } else {
      const meta = r.metadata as { heading?: string };
      const heading = meta.heading;
      citation = heading
        ? `${r.sourceName ?? 'Source'} > ${heading}`
        : (r.sourceName ?? 'Source');
    }

    return { ...r, citation };
  });
}
