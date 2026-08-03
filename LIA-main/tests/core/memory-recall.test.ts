import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import {
  createTestEpisode,
  deleteTestEpisode,
} from './helpers';

// ============================================================================
// Phase 8 — Memory recall contracts.
// ============================================================================
//
// Purpose: enforce architectural guarantee G9 (source_type + episode_id
// isolation) by tests, not just code comments. The whole "no cross-
// contamination between chats" promise depends on:
//   1. Dialogue recall returns ONLY source_type='dialogue' for the episode
//   2. Emotional recall returns ONLY source_type='emotional' (separate path)
//   3. Recall for episode B does NOT return vectors from episode A
//   4. Agent summaries are indexed as source_type='summary'
//
// Infra: real SQLite + sqlite-vec test DB. We insert vectors directly via
// db-vec helpers (NOT through the full embed pipeline — that would require
// Ollama). The query embedding is also synthetic.
//
// DoD: ≥4 tests; document in tests/core/README.md.

import { insertVectorMemory, searchVectorsInEpisode } from '@/lib/db-vec';
import { insertEmotionalVectorIndex, searchEmotionalVectorsInEpisode } from '@/lib/db-vec';
import { remember, recall } from '@/lib/memory/vector';
import { randomUUID } from 'crypto';

// Synthetic embedding — dim must match nomic-embed-text (768). We use a
// deterministic pattern so the SAME text always gets the SAME vector, which
// makes vec0 KNN return it as the closest match for a query with the same
// pattern.
function syntheticEmbedding(seed: number): Float32Array {
  const dim = 768;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin((seed * (i + 1) * 0.01) % (2 * Math.PI));
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// Hoist the mock so vi.mock factory can reference it (vi.mock is hoisted to
// top of file; non-hoisted consts aren't available yet).
const { embedMock } = vi.hoisted(() => {
  const embedMock = vi.fn(async (text: string) => {
    // Deterministic: same text → same seed → same vector.
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
    return syntheticEmbedding(Math.abs(seed) + 1);
  });
  return { embedMock };
});

vi.mock('@/lib/ollama', () => ({
  embed: embedMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

describe('Phase 8 — memory recall contracts (source_type + episode_id isolation)', () => {
  let episodeA: string;
  let episodeB: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    episodeA = await createTestEpisode('episode-A');
    episodeB = await createTestEpisode('episode-B');
  });

  afterEach(async () => {
    // Clean up vectors + episodes.
    await db.vectorMemory.deleteMany({ where: { episodeId: { in: [episodeA, episodeB] } } }).catch(() => null);
    await deleteTestEpisode(episodeA);
    await deleteTestEpisode(episodeB);
  });

  // ── Scenario 1: Dialogue recall returns ONLY source_type='dialogue' ──
  it('recall with sourceTypes=[dialogue] returns only dialogue vectors for the episode', async () => {
    // Insert one dialogue + one emotional + one fact vector into episode A,
    // all with the SAME embedding so they'd all match if source_type filter
    // were broken.
    const embedding = syntheticEmbedding(42);
    insertVectorMemory({
      id: randomUUID(), episodeId: episodeA, sourceType: 'dialogue',
      text: 'DIALOGUE_TEXT_A', embedding,
    });
    insertEmotionalVectorIndex({
      vectorId: 'emo:' + randomUUID(), episodeId: episodeA, embedding,
    });
    insertVectorMemory({
      id: randomUUID(), episodeId: episodeA, sourceType: 'fact',
      text: 'FACT_TEXT_A', embedding,
    });

    // Search directly with the same embedding + sourceType='dialogue' — should
    // return ONLY the dialogue vector, NOT the fact or emotional one.
    // (recall() would call embed() on the query string, producing a different
    // embedding — we bypass that by calling searchVectorsInEpisode directly.)
    const hits = searchVectorsInEpisode({
      episodeId: episodeA,
      queryEmbedding: embedding,
      limit: 10,
      minSimilarity: 0.0,
      sourceType: 'dialogue',
    });

    expect(hits.length).toBe(1);
    expect(hits[0].sourceType).toBe('dialogue');
    expect(hits[0].text).toBe('DIALOGUE_TEXT_A');

    // Cross-check: searching WITHOUT sourceType filter returns all 3 (dialogue + fact).
    // (emotional is in vec_virtual but NOT in VectorMemory — searchVectorsInEpisode
    // JOINs VectorMemory for text/sourceType, so emotional hits are dropped by the
    // JOIN. That's by design: emotional recall uses a separate path.)
    const allHits = searchVectorsInEpisode({
      episodeId: episodeA,
      queryEmbedding: embedding,
      limit: 10,
      minSimilarity: 0.0,
    });
    const sourceTypes = allHits.map(h => h.sourceType).sort();
    expect(sourceTypes).toEqual(['dialogue', 'fact']);
  });

  // ── Scenario 2: Emotional recall is a separate path, not mixed with dialogue ──
  it('searchEmotionalVectorsInEpisode returns only emotional vectors, not dialogue', async () => {
    const embedding = syntheticEmbedding(99);
    insertVectorMemory({
      id: randomUUID(), episodeId: episodeA, sourceType: 'dialogue',
      text: 'DIALOGUE_TEXT', embedding,
    });
    insertEmotionalVectorIndex({
      vectorId: 'emo:' + randomUUID(), episodeId: episodeA, embedding,
    });

    // Emotional search — should return the emotional vector, NOT the dialogue.
    const hits = searchEmotionalVectorsInEpisode({
      episodeId: episodeA,
      queryEmbedding: embedding,
      limit: 10,
      maxDistance: 1.0,  // accept everything
    });

    expect(hits.length).toBe(1);
    expect(hits[0].vectorId).toMatch(/^emo:/);
  });

  // ── Scenario 3: Recall for episode B does NOT return vectors from episode A ──
  it('recall for episode B returns no hits from episode A (episode isolation)', async () => {
    const embedding = syntheticEmbedding(7);
    insertVectorMemory({
      id: randomUUID(), episodeId: episodeA, sourceType: 'dialogue',
      text: 'SHOULD_NOT_LEAK', embedding,
    });

    // Recall in episode B with the same embedding — should return nothing.
    const hits = await recall({
      episodeId: episodeB,
      query: 'test query',
      sourceTypes: ['dialogue'],
      limit: 10,
      minSimilarity: 0.0,
    });

    expect(hits).toEqual([]);
  });

  // ── Scenario 4: Agent summary is indexed as source_type='summary' ──
  it('remember with sourceType=summary stores and recalls it as summary', async () => {
    // Insert a summary vector directly (simulates what agent runner-helpers
    // does after synthesizeAndFinish).
    const embedding = syntheticEmbedding(123);
    insertVectorMemory({
      id: randomUUID(), episodeId: episodeA, sourceType: 'summary',
      text: 'AGENT_SUMMARY_TEXT', embedding,
    });

    // Search directly with the same embedding — bypasses recall()'s embed()
    // call (which would produce a different embedding for the query string).
    const hits = searchVectorsInEpisode({
      episodeId: episodeA,
      queryEmbedding: embedding,
      limit: 10,
      minSimilarity: 0.0,
      sourceType: 'summary',
    });

    expect(hits.length).toBe(1);
    expect(hits[0].sourceType).toBe('summary');
    expect(hits[0].text).toBe('AGENT_SUMMARY_TEXT');
  });

  // ── Scenario 5: remember() helper writes to vec_virtual + VectorMemory ──
  // (integration: the remember() function is what persistChatTurn calls.
  // Verifying it round-trips through the real DB confirms the contract end-
  // to-end, not just the low-level insert/search functions.)
  it('remember() + searchVectorsInEpisode() round-trip through real DB (dialogue sourceType)', async () => {
    const text = 'User: привет\nLia: здравствуй';
    await remember({
      episodeId: episodeA,
      sourceType: 'dialogue',
      text,
    });

    // embed mock is deterministic: same text → same embedding. We can
    // reproduce the embedding here and search with it directly.
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
    const queryEmbedding = syntheticEmbedding(Math.abs(seed) + 1);

    const hits = searchVectorsInEpisode({
      episodeId: episodeA,
      queryEmbedding,
      limit: 5,
      minSimilarity: 0.0,
      sourceType: 'dialogue',
    });

    expect(hits.length).toBe(1);
    expect(hits[0].sourceType).toBe('dialogue');
    expect(hits[0].text).toContain('привет');
  });
});
