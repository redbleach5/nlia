// ============================================================================
// Reciprocal Rank Fusion (RRF) — объединение ранжированных списков.
// ============================================================================
//
// RRF — простой и эффективный алгоритм fusion: для каждого item считаем сумму
// 1 / (k + rank) по всем спискам, где rank — позиция item в списке (0-indexed).
// k = 60 — стандартное значение, balancing early vs late ranks.
//
// Преимущества:
//   - Не требует нормализации scores (важно: BM25 score и cosine similarity
//     имеют разные масштабы — прямое сложение дало бы перекос в сторону BM25)
//   - Устойчив к outlier'ам (один очень высокий score не доминирует)
//   - Простота: ~20 строк кода
//
// Используется для объединения vector search hits и BM25 hits в search.ts.

import type { SearchResult } from './types';

/**
 * Объединить несколько ранжированных списков через Reciprocal Rank Fusion.
 *
 * @param lists  массив ранжированных списков (каждый отсортирован по убыванию score)
 * @param k      константа RRF (60 по умолчанию) — баланс между ранними и поздними позициями
 * @returns объединённый список, отсортированный по убыванию RRF score
 */
export function rrf(lists: SearchResult[][], k = 60): SearchResult[] {
  const scores = new Map<string, { score: number; item: SearchResult }>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      const existing = scores.get(item.id);
      const contribution = 1 / (k + rank + 1);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(item.id, { score: contribution, item });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(s => ({
      ...s.item,
      score: s.score,
      matchType: 'fused' as const,
    }));
}
