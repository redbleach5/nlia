// Smoke tests for src/lib/kb/rrf.ts — Reciprocal Rank Fusion
//
// Тестируют:
//   - Fusion двух списков с общими элементами
//   - Порядок по убыванию RRF score
//   - Item только в одном списке тоже попадает в результат
//   - Пустые списки → пустой результат
//   - matchType меняется на 'fused'

import { describe, it, expect } from 'vitest';
import { rrf } from '@/lib/kb/rrf';
import type { SearchResult } from '@/lib/kb/types';

function makeHit(id: string, score: number, matchType: SearchResult['matchType'] = 'vector'): SearchResult {
  return {
    id,
    sourceId: 'src',
    content: `content ${id}`,
    metadata: { isComment: false } as never,
    score,
    matchType,
  };
}

describe('rrf', () => {
  it('returns empty array for empty input', () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
  });

  it('fuses two lists with shared items (shared items rank higher)', () => {
    // Item "a" is rank 0 in list1 AND rank 0 in list2 → highest fused score
    // Item "b" is rank 1 in list1 only → lower score
    // Item "c" is rank 0 in list2 only → lower score
    const list1 = [makeHit('a', 0.9), makeHit('b', 0.8)];
    const list2 = [makeHit('a', 0.5), makeHit('c', 0.4)];

    const fused = rrf([list1, list2]);

    // "a" должен быть на первом месте (есть в обоих списках, на ранних позициях)
    expect(fused[0].id).toBe('a');
    expect(fused.length).toBe(3);  // a, b, c — все уникальные

    // Все matchType должны стать 'fused'
    for (const r of fused) {
      expect(r.matchType).toBe('fused');
    }
  });

  it('preserves items that appear only in one list', () => {
    const list1 = [makeHit('x', 1.0)];
    const list2 = [makeHit('y', 1.0)];

    const fused = rrf([list1, list2]);
    expect(fused.length).toBe(2);
    const ids = new Set(fused.map(r => r.id));
    expect(ids.has('x')).toBe(true);
    expect(ids.has('y')).toBe(true);
  });

  it('sorts by descending RRF score', () => {
    // a: rank 0 in list1, rank 1 in list2 → 1/(60+1) + 1/(60+2) ≈ 0.0327
    // b: rank 1 in list1, rank 0 in list2 → 1/(60+2) + 1/(60+1) ≈ 0.0327
    // a и b имеют одинаковый fused score (rank 0+1 vs 1+0 симметричны)
    // c: rank 0 in list1 only → 1/(60+1) ≈ 0.0164
    const list1 = [makeHit('a', 0.9), makeHit('b', 0.8), makeHit('c', 0.7)];
    const list2 = [makeHit('b', 0.5), makeHit('a', 0.4)];

    const fused = rrf([list1, list2]);

    // c должен быть последним (только в одном списке, на не первой позиции)
    expect(fused[fused.length - 1].id).toBe('c');

    // a и b должны быть на первых двух местах (оба в двух списках)
    const top2 = new Set([fused[0].id, fused[1].id]);
    expect(top2.has('a')).toBe(true);
    expect(top2.has('b')).toBe(true);
  });

  it('uses k=60 by default (standard RRF constant)', () => {
    // Проверяем что k=60 даёт ожидаемый score для rank 0
    const list1 = [makeHit('a', 1.0)];
    const fused = rrf([list1]);
    // 1 / (60 + 0 + 1) = 1/61 ≈ 0.01639
    expect(fused[0].score).toBeCloseTo(1 / 61, 5);
  });

  it('handles custom k parameter', () => {
    const list1 = [makeHit('a', 1.0)];
    const fused = rrf([list1], 10);  // k=10
    // 1 / (10 + 0 + 1) = 1/11 ≈ 0.0909
    expect(fused[0].score).toBeCloseTo(1 / 11, 5);
  });

  it('does not duplicate items that appear multiple times in same list', () => {
    // Если list содержит дубликаты — они должны считаться как один item
    // (это defensive — реальные lists не должны содержать дубликаты)
    const list1 = [makeHit('a', 1.0), makeHit('a', 0.5)];
    const fused = rrf([list1]);
    // Map-keyed-by-id дедуплицирует, остаётся первый встреченный
    expect(fused.length).toBe(1);
  });
});
