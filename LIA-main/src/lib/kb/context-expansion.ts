import 'server-only';

// ============================================================================
// KB context expansion — добавляет parent + sibling chunks для лучшего контекста.
// ============================================================================
//
// Проблема: searchKB возвращает matching chunks изолированно. Если chunk — это
// параграф из середины раздела, модель не видит heading родителя и предыдущий
// параграф. Для «что такое EGTS_SR_ADAS_DATA?» находит chunk с упоминанием,
// но без определения — потому что определение в предыдущем chunk.
//
// Решение: для каждого top-hit загружаем parent chunk (по parentId) и 1
// sibling (предыдущий chunk по position в том же source). Без LLM call —
// просто доп. query к Prisma. Контекст для модели становится полнее.
//
// Когда НЕ включать:
//   - fast quality mode (LIA_QUALITY_MODE=fast) — extra DB queries
//   - micro tier — минимальный контекст
//   - chunk уже имеет heading в metadata (DocumentChunker добавляет) —
//     parent избыточен
//
// Controlled by LIA_KB_CONTEXT_EXPANSION env var (default: true).
// Pipeline проверяет quality mode и tier перед вызовом.

import { db } from '@/lib/db';
import type { SearchResult } from './types';
import { logger } from '@/lib/logger';

const MAX_EXPANSION_PER_HIT = 2;  // parent + 1 sibling
const MAX_TOTAL_EXPANSION_CHUNKS = 4;  // limit чтобы не раздувать prompt

interface ExpansionResult {
  expandedHits: SearchResult[];
  expansionCount: number;
}

/**
 * Расширить hits parent + sibling chunks для лучшего контекста.
 *
 * Для каждого hit:
 *   1. Если hit.metadata.heading есть И parentId не задан — chunk уже
 *      самостоятельный, skip.
 *   2. Загружаем parent chunk (по parentId) — добавляем ПЕРЕД hit.
 *   3. Загружаем previous sibling (chunk из того же source с position-1) —
 *      добавляем ПЕРЕД hit.
 *
 * Дедупликация: если parent/sibling уже в hits — не добавляем повторно.
 *
 * @param hits  top hits из searchKB (уже отсортированы по score)
 * @returns expanded hits с parent/sibling context, deduped
 */
export async function expandKbHitsWithContext(
  hits: SearchResult[],
): Promise<ExpansionResult> {
  if (process.env.LIA_KB_CONTEXT_EXPANSION === 'false') {
    return { expandedHits: hits, expansionCount: 0 };
  }

  if (hits.length === 0) {
    return { expandedHits: hits, expansionCount: 0 };
  }

  const existingIds = new Set(hits.map(h => h.id));
  const expanded: SearchResult[] = [];
  let expansionCount = 0;

  for (const hit of hits) {
    expanded.push(hit);

    if (expansionCount >= MAX_TOTAL_EXPANSION_CHUNKS) break;

    // Determine sourceId и position из hit
    const meta = hit.metadata as {
      heading?: string;
      sectionIndex?: number;
      charStart?: number;
      charEnd?: number;
    };

    // Для document chunks с heading — parent избыточен (heading уже в content)
    if (meta.heading) {
      continue;
    }

    // Загружаем parent + sibling в одной query
    try {
      // Sibling: previous chunk in same source (position-based)
      // Parent: chunk with id = hit.parentId (if set)
      const siblingQuery = hit.metadata
        ? db.chunk.findFirst({
            where: {
              sourceId: hit.sourceId,
              id: { not: hit.id },
            },
            orderBy: { position: 'desc' },
            select: {
              id: true,
              content: true,
              metadata: true,
              parentId: true,
              position: true,
              source: { select: { type: true, name: true } },
            },
          })
        : null;

      // We need position of current hit to find sibling. Load it.
      const currentChunk = await db.chunk.findUnique({
        where: { id: hit.id },
        select: { position: true, parentId: true },
      });

      const expansions: SearchResult[] = [];

      if (currentChunk?.parentId) {
        // Load parent
        const parent = await db.chunk.findUnique({
          where: { id: currentChunk.parentId },
          select: {
            id: true,
            content: true,
            metadata: true,
            sourceId: true,
            source: { select: { type: true, name: true } },
          },
        });
        if (parent && !existingIds.has(parent.id)) {
          let parentMetadata: Record<string, unknown>;
          try {
            parentMetadata = JSON.parse(parent.metadata);
          } catch {
            parentMetadata = {};
          }
          expansions.push({
            id: parent.id,
            sourceId: parent.sourceId,
            content: parent.content,
            metadata: parentMetadata as SearchResult['metadata'],
            score: 0,  // expansion chunk, не из search
            matchType: 'context_expansion',
            sourceName: parent.source.name,
            sourceType: parent.source.type as SearchResult['sourceType'],
            citation: hit.citation,  // inherit citation from child
          });
          existingIds.add(parent.id);
        }
      }

      // Sibling: previous position in same source
      if (currentChunk && siblingQuery === null) {
        const sibling = await db.chunk.findFirst({
          where: {
            sourceId: hit.sourceId,
            position: { lt: currentChunk.position },
            id: { notIn: [...existingIds] },
          },
          orderBy: { position: 'desc' },
          select: {
            id: true,
            content: true,
            metadata: true,
            sourceId: true,
            source: { select: { type: true, name: true } },
          },
        });
        if (sibling && !existingIds.has(sibling.id)) {
          let siblingMetadata: Record<string, unknown>;
          try {
            siblingMetadata = JSON.parse(sibling.metadata);
          } catch {
            siblingMetadata = {};
          }
          expansions.push({
            id: sibling.id,
            sourceId: sibling.sourceId,
            content: sibling.content,
            metadata: siblingMetadata as SearchResult['metadata'],
            score: 0,
            matchType: 'context_expansion',
            sourceName: sibling.source.name,
            sourceType: sibling.source.type as SearchResult['sourceType'],
            citation: hit.citation,
          });
          existingIds.add(sibling.id);
        }
      }

      // Add expansions ПЕРЕД hit (но мы уже push'нули hit, поэтому insert
      // перед следующим). Проще: добавить expansions после hit, но с пометкой
      // matchType='context_expansion' — prompt builder может различать.
      for (const exp of expansions.slice(0, MAX_EXPANSION_PER_HIT)) {
        expanded.push(exp);
        expansionCount++;
        if (expansionCount >= MAX_TOTAL_EXPANSION_CHUNKS) break;
      }
    } catch (e) {
      // Non-fatal — expansion failed, continue with original hit
      logger.debug('kb', 'Context expansion failed for hit', {
        hitId: hit.id.slice(0, 8),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { expandedHits: expanded, expansionCount };
}
