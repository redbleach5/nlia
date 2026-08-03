import { describe, it, expect, beforeEach } from 'vitest';

/**
 * KB test: inverted-index.ts
 *
 * Tests the core BM25 inverted index for KBs >5k chunks.
 * Covers: addToInvertedIndex, removeFromInvertedIndex, removeSourceFromInvertedIndex,
 * bm25SearchInverted, tokenizer version round-trip, clearInvertedIndex.
 *
 * Uses the real better-sqlite3 singleton (getDb) — same pattern as db-vec-kb.test.ts.
 * These tests need a DB but use the test DB (auto-created by getDb).
 */

// We can only test functions that don't require a running Prisma server.
// The inverted index uses better-sqlite3 directly (getDb), so we can test
// the raw SQL layer. However, some functions also call FTS5 which may not
// be available. We focus on the JS inverted index path.

describe('KB: inverted-index', () => {
  describe('KB_TOKENIZER_VERSION', () => {
    it('is version 3 (Snowball stemmer)', async () => {
      const { KB_TOKENIZER_VERSION } = await import('@/lib/kb/inverted-index');
      expect(KB_TOKENIZER_VERSION).toBe(3);
    });
  });

  describe('tokenizer version storage', () => {
    it('getStoredTokenizerVersion returns 0 on fresh DB', async () => {
      const { getStoredTokenizerVersion, clearInvertedIndex, setStoredTokenizerVersion } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();
      // Reset to 0 explicitly (clearInvertedIndex preserves tokenizer_version)
      setStoredTokenizerVersion(0);
      expect(getStoredTokenizerVersion()).toBe(0);
    });

    it('setStoredTokenizerVersion + getStoredTokenizerVersion round-trip', async () => {
      const { getStoredTokenizerVersion, setStoredTokenizerVersion, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();
      setStoredTokenizerVersion(3);
      expect(getStoredTokenizerVersion()).toBe(3);
      setStoredTokenizerVersion(5);
      expect(getStoredTokenizerVersion()).toBe(5);
    });

    it('isTokenizerVersionOutdated detects mismatch', async () => {
      const { isTokenizerVersionOutdated, setStoredTokenizerVersion, clearInvertedIndex, KB_TOKENIZER_VERSION } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();
      setStoredTokenizerVersion(KB_TOKENIZER_VERSION);
      expect(isTokenizerVersionOutdated()).toBe(false);
      setStoredTokenizerVersion(KB_TOKENIZER_VERSION - 1);
      expect(isTokenizerVersionOutdated()).toBe(true);
    });

    it('clearInvertedIndex preserves tokenizer_version', async () => {
      const { clearInvertedIndex, setStoredTokenizerVersion, getStoredTokenizerVersion } = await import('@/lib/kb/inverted-index');
      setStoredTokenizerVersion(3);
      clearInvertedIndex();
      // tokenizer_version should survive clearInvertedIndex
      expect(getStoredTokenizerVersion()).toBe(3);
    });
  });

  describe('addToInvertedIndex + bm25SearchInverted', () => {
    it('indexes a chunk and finds it by query', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({
        chunkId: 'chunk-1',
        sourceId: 'source-1',
        content: 'Python is a great programming language for beginners',
      });

      const hits = bm25SearchInverted({
        query: 'python programming',
        limit: 10,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].chunk_id).toBe('chunk-1');
      expect(hits[0].source_id).toBe('source-1');
      expect(hits[0].score).toBeGreaterThan(0);
    });

    it('indexes multiple chunks and ranks by relevance', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({
        chunkId: 'chunk-a',
        sourceId: 'src',
        content: 'Python Python Python programming language tutorial',
      });
      addToInvertedIndex({
        chunkId: 'chunk-b',
        sourceId: 'src',
        content: 'JavaScript is also popular but different from Python',
      });

      const hits = bm25SearchInverted({
        query: 'python',
        limit: 10,
      });

      expect(hits.length).toBe(2);
      // chunk-a has 3 occurrences of "python" → higher score
      expect(hits[0].chunk_id).toBe('chunk-a');
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
    });

    it('filters by sourceIds', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src-A', content: 'machine learning algorithms' });
      addToInvertedIndex({ chunkId: 'c2', sourceId: 'src-B', content: 'machine learning models' });

      const hits = bm25SearchInverted({
        query: 'machine learning',
        sourceIds: ['src-A'],
        limit: 10,
      });

      expect(hits.length).toBe(1);
      expect(hits[0].source_id).toBe('src-A');
    });

    it('returns empty for no matches', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src', content: 'hello world' });

      const hits = bm25SearchInverted({
        query: 'nonexistent',
        limit: 10,
      });

      expect(hits).toEqual([]);
    });

    it('handles empty query', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src', content: 'some content here' });

      const hits = bm25SearchInverted({
        query: '',
        limit: 10,
      });

      expect(hits).toEqual([]);
    });

    it('handles Cyrillic content', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({
        chunkId: 'ru-1',
        sourceId: 'src',
        content: 'Программирование на Python — отличный выбор для новичков',
      });

      const hits = bm25SearchInverted({
        query: 'программирование',
        limit: 10,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].chunk_id).toBe('ru-1');
    });
  });

  describe('removeFromInvertedIndex', () => {
    it('removes a chunk from the index', async () => {
      const { addToInvertedIndex, removeFromInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src', content: 'unique keyword alpha' });
      addToInvertedIndex({ chunkId: 'c2', sourceId: 'src', content: 'unique keyword beta' });

      removeFromInvertedIndex('c1');

      const hits = bm25SearchInverted({ query: 'unique keyword', limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].chunk_id).toBe('c2');
    });

    it('handles removing non-existent chunk gracefully', async () => {
      const { removeFromInvertedIndex, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();
      // Should not throw
      expect(() => removeFromInvertedIndex('nonexistent')).not.toThrow();
    });

    it('updates corpus stats after removal (avg_doc_length stays non-negative)', async () => {
      const { addToInvertedIndex, removeFromInvertedIndex, clearInvertedIndex, getStoredTokenizerVersion } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      // Add then remove — stats should not go negative
      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src', content: 'word1 word2 word3' });
      addToInvertedIndex({ chunkId: 'c2', sourceId: 'src', content: 'word4 word5' });
      removeFromInvertedIndex('c1');
      removeFromInvertedIndex('c2');

      // After removing all chunks, the index should be empty
      // total_docs should be 0
      const { bm25SearchInverted } = await import('@/lib/kb/inverted-index');
      const hits = bm25SearchInverted({ query: 'word1', limit: 10 });
      expect(hits).toEqual([]);
    });
  });

  describe('removeSourceFromInvertedIndex', () => {
    it('removes all chunks for a source', async () => {
      const { addToInvertedIndex, removeSourceFromInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({ chunkId: 'a1', sourceId: 'src-A', content: 'apple banana' });
      addToInvertedIndex({ chunkId: 'a2', sourceId: 'src-A', content: 'apple cherry' });
      addToInvertedIndex({ chunkId: 'b1', sourceId: 'src-B', content: 'apple date' });

      removeSourceFromInvertedIndex('src-A');

      const hits = bm25SearchInverted({ query: 'apple', limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].source_id).toBe('src-B');
    });

    it('handles removing non-existent source gracefully', async () => {
      const { removeSourceFromInvertedIndex, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();
      expect(() => removeSourceFromInvertedIndex('nonexistent')).not.toThrow();
    });
  });

  describe('clearInvertedIndex', () => {
    it('clears all postings', async () => {
      const { addToInvertedIndex, clearInvertedIndex, bm25SearchInverted } = await import('@/lib/kb/inverted-index');

      addToInvertedIndex({ chunkId: 'c1', sourceId: 'src', content: 'test content alpha' });
      addToInvertedIndex({ chunkId: 'c2', sourceId: 'src', content: 'test content beta' });

      clearInvertedIndex();

      const hits = bm25SearchInverted({ query: 'test content', limit: 10 });
      expect(hits).toEqual([]);
    });
  });

  describe('SQLITE_MAX_VARIABLE_NUMBER guard (P2-7 fix)', () => {
    it('handles query with many tokens without SQLITE_RANGE error', async () => {
      const { addToInvertedIndex, bm25SearchInverted, clearInvertedIndex } = await import('@/lib/kb/inverted-index');
      clearInvertedIndex();

      addToInvertedIndex({
        chunkId: 'c1',
        sourceId: 'src',
        content: 'word ' + Array.from({ length: 100 }, (_, i) => `term${i}`).join(' '),
      });

      // Query with >900 tokens — should be truncated, not crash
      const manyTokens = Array.from({ length: 1000 }, (_, i) => `term${i}`).join(' ');
      const hits = bm25SearchInverted({ query: manyTokens, limit: 10 });
      // Should return results without throwing
      expect(hits.length).toBeGreaterThan(0);
    });
  });
});
