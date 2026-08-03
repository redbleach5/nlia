import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChunkDelete = vi.fn(async () => ({}));
const mockDeleteKbVector = vi.fn();
const mockRemoveFromInvertedIndex = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    chunk: { delete: mockChunkDelete },
  },
}));

vi.mock('@/lib/kb/db-vec-kb', () => ({
  deleteKbVector: mockDeleteKbVector,
}));

vi.mock('@/lib/kb/inverted-index', () => ({
  removeFromInvertedIndex: mockRemoveFromInvertedIndex,
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('rollbackChunkWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes Prisma chunk and both index layers', async () => {
    const { rollbackChunkWrite } = await import('@/lib/kb/indexer');
    await rollbackChunkWrite('chunk-abc');

    expect(mockChunkDelete).toHaveBeenCalledWith({ where: { id: 'chunk-abc' } });
    expect(mockDeleteKbVector).toHaveBeenCalledWith('chunk-abc');
    expect(mockRemoveFromInvertedIndex).toHaveBeenCalledWith('chunk-abc');
  });

  it('still attempts index cleanup when Prisma delete fails', async () => {
    mockChunkDelete.mockRejectedValueOnce(new Error('db locked'));
    const { rollbackChunkWrite } = await import('@/lib/kb/indexer');
    await rollbackChunkWrite('chunk-xyz');

    expect(mockDeleteKbVector).toHaveBeenCalledWith('chunk-xyz');
    expect(mockRemoveFromInvertedIndex).toHaveBeenCalledWith('chunk-xyz');
  });
});
