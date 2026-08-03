// Smoke tests for src/lib/kb/bm25.ts — tokenizer + BM25 scoring
//
// ВНИМАНИЕ: bm25Search() требует БД (db.chunk.findMany). Тестируем только
// tokenize() в изоляции. Полный BM25 end-to-end — в integration тестах
// после indexer.ts (Phase 2b).
//
// Тестируют:
//   - tokenize: lowercase, split, filter stopwords, filter length ≤ 1
//   - tokenize: Unicode (Cyrillic) support
//   - tokenize: punctuation stripping
//   - tokenize: empty input

import { describe, it, expect } from 'vitest';
import { tokenize } from '@/lib/kb/bm25';

describe('tokenize', () => {
  it('lowercases input', () => {
    const tokens = tokenize('Hello WORLD Foo');
    expect(tokens).toEqual(['hello', 'world', 'foo']);
  });

  it('splits on non-alphanumeric (spaces, punctuation)', () => {
    const tokens = tokenize('foo, bar! baz? qux; quux:');
    expect(tokens).toEqual(['foo', 'bar', 'baz', 'qux', 'quux']);
  });

  it('filters English stopwords', () => {
    const tokens = tokenize('the quick brown fox jumps over the lazy dog');
    // 'the' и 'over' — stopwords. Snowball: 'jumps' → 'jump', 'lazy' → 'lazi'.
    expect(tokens).toEqual(['quick', 'brown', 'fox', 'jump', 'lazi', 'dog']);
  });

  it('filters Russian stopwords', () => {
    const tokens = tokenize('и в на с по для от из что это как не но');
    expect(tokens).toEqual([]);  // все слова — stopwords
  });

  it('filters tokens with length ≤ 1', () => {
    const tokens = tokenize('a b c d ab cd ef');
    expect(tokens).toEqual(['ab', 'cd', 'ef']);
  });

  it('preserves Cyrillic characters', () => {
    const tokens = tokenize('Привет мир документация');
    // Snowball Russian: 'документация' → 'документац' (strip 'ия' suffix).
    // 'привет' — без изменений. 'мир' — 3 chars, stemmer skip.
    expect(tokens).toEqual(['привет', 'мир', 'документац']);
  });

  it('preserves digits', () => {
    const tokens = tokenize('AUTH-123 error code 404 null pointer');
    expect(tokens).toEqual(['auth', '123', 'error', 'code', '404', 'null', 'pointer']);
  });

  it('handles mixed Latin + Cyrillic', () => {
    const tokens = tokenize('AUTH-123 ошибка NullPointerException');
    // Snowball: 'ошибка' → 'ошибк', 'nullpointerexception' → 'nullpointerexcept'.
    expect(tokens).toEqual(['auth', '123', 'ошибк', 'nullpointerexcept']);
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('.,!?')).toEqual([]);
  });

  it('handles newlines and tabs as separators', () => {
    const tokens = tokenize('line1\nline2\ttabbed\r\nwindows');
    // Snowball: 'tabbed' → 'tab', 'windows' → 'window'.
    expect(tokens).toEqual(['line1', 'line2', 'tab', 'window']);
  });

  it('handles underscores as separator', () => {
    const tokens = tokenize('foo_bar baz_qux');
    // _ — non-alphanumeric, поэтому split'ит
    expect(tokens).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('preserves CamelCase after lowercasing (no special handling)', () => {
    // tokenize не делает CamelCase splitting — это responsibility caller'а
    const tokens = tokenize('NullPointerException');
    // Snowball English: 'nullpointerexception' → 'nullpointerexcept' (strip 'ion').
    expect(tokens).toEqual(['nullpointerexcept']);
  });
});
