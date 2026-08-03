// Integration tests — upload → index → search (mocked embeddings, real SQLite).
//
// Требует: `bun run db:push` (таблицы Source/Chunk + kb_vec_virtual).
// Ollama не нужен — embedForKb/embedBatchForKb замоканы.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { unlink } from 'fs/promises';
import { db } from '@/lib/db';
import { saveUploadedFile, indexDocumentSource } from '@/lib/kb/indexer';
import { searchKB } from '@/lib/kb/search';
import { deleteKbVectorsForSource } from '@/lib/kb/db-vec-kb';
import { removeSourceFromInvertedIndex } from '@/lib/kb/inverted-index';

function syntheticEmbedding(text: string): Float32Array {
  const dim = 768;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const c = text.charCodeAt(i % text.length);
    vec[i] = Math.sin((c * (i + 1) * 0.01) % (2 * Math.PI));
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

vi.mock('@/lib/kb/embed', () => ({
  embedForKb: vi.fn(async (text: string) => syntheticEmbedding(text)),
  embedBatchForKb: vi.fn(async (texts: string[]) =>
    texts.map(t => syntheticEmbedding(t)),
  ),
  KB_EMBED_BATCH_SIZE: 8,
}));

describe('KB integration', () => {
  const cleanup: Array<{ sourceId: string; filePath?: string }> = [];

  afterEach(async () => {
    for (const { sourceId, filePath } of cleanup) {
      if (sourceId !== 'noop') {
        deleteKbVectorsForSource(sourceId);
        removeSourceFromInvertedIndex(sourceId);
        await db.source.delete({ where: { id: sourceId } }).catch(() => null);
      }
      if (filePath) await unlink(filePath).catch(() => null);
    }
    cleanup.length = 0;
  });

  it('markdown upload → index → search returns matching chunk', async () => {
    const markdown = [
      '# Architecture',
      '',
      'Lia uses dual-memory: episodes and knowledge base.',
      '',
      '## Search',
      '',
      'Hybrid search combines vector retrieval and BM25 keyword matching.',
    ].join('\n');

    const buffer = Buffer.from(markdown, 'utf-8');
    const { filePath, contentHash, fileSize } = await saveUploadedFile('integration-arch.md', buffer);

    const source = await db.source.create({
      data: {
        type: 'document',
        name: 'Integration Test',
        config: JSON.stringify({
          filePath,
          mimeType: 'text/markdown',
          fileSize,
          contentHash,
        }),
        status: 'idle',
      },
    });
    cleanup.push({ sourceId: source.id, filePath });

    await indexDocumentSource(source.id);

    const updated = await db.source.findUnique({ where: { id: source.id } });
    expect(updated?.status).toBe('ready');
    expect(updated?.chunkCount).toBeGreaterThan(0);

    const results = await searchKB({ query: 'dual-memory', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some(r => r.content.toLowerCase().includes('dual-memory')),
    ).toBe(true);
  });

  it('saveUploadedFile stores binary contentHash (not utf-8 corruption)', async () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const { filePath, contentHash } = await saveUploadedFile('probe.pdf', buf);

    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    cleanup.push({ sourceId: 'noop', filePath });
  });
});
