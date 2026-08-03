// Integration tests for src/lib/kb/code-indexer.ts
//
// Requires: `bun run db:push`. Ollama not needed — embedBatchForKb mocked.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { db } from '@/lib/db';
import {
  createCodebaseSource,
  indexCodebaseSource,
  reindexCodebaseFile,
  removeCodebaseFile,
} from '@/lib/kb/code-indexer';
import { deleteKbVectorsForSource } from '@/lib/kb/db-vec-kb';
import { removeSourceFromInvertedIndex } from '@/lib/kb/inverted-index';

function syntheticEmbedding(text: string): Float32Array {
  const dim = 768;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const c = text.charCodeAt(i % Math.max(text.length, 1));
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

describe('code-indexer', () => {
  const cleanup: Array<{ sourceId: string; projectDir?: string }> = [];

  afterEach(async () => {
    for (const { sourceId, projectDir } of cleanup) {
      deleteKbVectorsForSource(sourceId);
      removeSourceFromInvertedIndex(sourceId);
      await db.chunk.deleteMany({ where: { sourceId } }).catch(() => null);
      await db.source.delete({ where: { id: sourceId } }).catch(() => null);
      if (projectDir) await rm(projectDir, { recursive: true, force: true }).catch(() => null);
    }
    cleanup.length = 0;
  });

  async function setupProject(files: Record<string, string>) {
    const projectDir = await mkdtemp(join(tmpdir(), 'lia-codebase-test-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(projectDir, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    const sourceId = await createCodebaseSource({
      name: 'Test Codebase',
      projectPath: projectDir,
      watchEnabled: false,
    });
    cleanup.push({ sourceId, projectDir });
    return { sourceId, projectDir };
  }

  it('indexCodebaseSource indexes TypeScript symbols into chunks', async () => {
    const { sourceId } = await setupProject({
      'lib/math.ts': [
        '/** Adds numbers. */',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n'),
    });

    await indexCodebaseSource(sourceId);

    const source = await db.source.findUnique({ where: { id: sourceId } });
    expect(source?.status).toBe('ready');
    expect(source?.chunkCount).toBeGreaterThan(0);

    const chunks = await db.chunk.findMany({ where: { sourceId } });
    const symbolNames = chunks
      .map(c => {
        try {
          return JSON.parse(c.metadata).symbolName as string;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    expect(symbolNames).toContain('add');
  });

  it('reindexCodebaseFile updates chunks when file changes', async () => {
    const { sourceId, projectDir } = await setupProject({
      'lib/util.ts': 'export const VERSION = 1;',
    });

    await indexCodebaseSource(sourceId);
    const before = await db.chunk.count({ where: { sourceId } });
    expect(before).toBeGreaterThan(0);

    await writeFile(
      join(projectDir, 'lib/util.ts'),
      'export const VERSION = 2;\nexport function bump() { return VERSION + 1; }',
      'utf8',
    );

    await reindexCodebaseFile(sourceId, 'lib/util.ts');

    const chunks = await db.chunk.findMany({ where: { sourceId } });
    const symbolNames = chunks
      .map(c => {
        try {
          return JSON.parse(c.metadata).symbolName as string;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    expect(symbolNames).toContain('bump');
  });

  it('reindexCodebaseFile waits for in-flight indexCodebaseSource', async () => {
    const { sourceId } = await setupProject({
      'a.ts': 'export const A = 1;',
    });

    const indexPromise = indexCodebaseSource(sourceId);
    await new Promise(r => setTimeout(r, 50));
    const reindexPromise = reindexCodebaseFile(sourceId, 'a.ts');

    await Promise.all([indexPromise, reindexPromise]);

    const source = await db.source.findUnique({ where: { id: sourceId } });
    expect(source?.status).toBe('ready');
    expect(await db.chunk.count({ where: { sourceId } })).toBeGreaterThan(0);
  });

  it('removeCodebaseFile deletes chunks for removed file', async () => {
    const { sourceId } = await setupProject({
      'keep.ts': 'export const KEEP = 1;',
      'drop.ts': 'export const DROP = 1;',
    });

    await indexCodebaseSource(sourceId);
    const before = await db.chunk.count({ where: { sourceId } });
    expect(before).toBeGreaterThan(0);

    await removeCodebaseFile(sourceId, 'drop.ts');

    const dropChunks = await db.chunk.count({
      where: { sourceId, metadata: { contains: '"filePath":"drop.ts"' } },
    });
    expect(dropChunks).toBe(0);

    const keepChunks = await db.chunk.count({
      where: { sourceId, metadata: { contains: '"filePath":"keep.ts"' } },
    });
    expect(keepChunks).toBeGreaterThan(0);
  });

  it('does not advance file hash when chunk insert partially fails', async () => {
    const vecMod = await import('@/lib/kb/db-vec-kb');
    const originalInsert = vecMod.insertKbVector;
    let callCount = 0;
    const insertSpy = vi.spyOn(vecMod, 'insertKbVector').mockImplementation((...args) => {
      callCount++;
      if (callCount === 2) throw new Error('simulated vec insert failure');
      return originalInsert(...args);
    });

    const { sourceId, projectDir } = await setupProject({
      'lib/a.ts': [
        'export function alpha() { return 1; }',
        'export function beta() { return 2; }',
      ].join('\n'),
    });

    await expect(indexCodebaseSource(sourceId)).resolves.toBeUndefined();

    const source = await db.source.findUnique({ where: { id: sourceId } });
    const cfg = JSON.parse(source!.config) as { fileHashes?: Record<string, string> };
    expect(cfg.fileHashes?.['lib/a.ts']).toBeUndefined();

    insertSpy.mockRestore();

    await indexCodebaseSource(sourceId);
    const after = await db.source.findUnique({ where: { id: sourceId } });
    const cfgAfter = JSON.parse(after!.config) as { fileHashes?: Record<string, string> };
    expect(cfgAfter.fileHashes?.['lib/a.ts']).toBeDefined();
    expect(await db.chunk.count({
      where: { sourceId, metadata: { contains: '"filePath":"lib/a.ts"' } },
    })).toBeGreaterThan(0);

    await rm(projectDir, { recursive: true, force: true }).catch(() => null);
  });

  it('retries changed file when hash was not advanced after chunk delete', async () => {
    const { sourceId, projectDir } = await setupProject({
      'retry.ts': 'export const V = 1;',
    });

    await indexCodebaseSource(sourceId);

    await writeFile(
      join(projectDir, 'retry.ts'),
      'export const V = 2;\nexport function next() { return V + 1; }',
      'utf8',
    );

    // Simulate crash after delete, before hash advance: remove chunks but keep old hash.
    await db.chunk.deleteMany({
      where: { sourceId, metadata: { contains: '"filePath":"retry.ts"' } },
    });

    await indexCodebaseSource(sourceId);

    const chunks = await db.chunk.findMany({
      where: { sourceId, metadata: { contains: '"filePath":"retry.ts"' } },
    });
    const symbols = chunks.map(c => JSON.parse(c.metadata).symbolName as string).filter(Boolean);
    expect(symbols).toContain('next');
  });
});
