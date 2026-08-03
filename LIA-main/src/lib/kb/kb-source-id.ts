import 'server-only';

import { db } from '@/lib/db';

/**
 * Разрешить Source.id по переданному id: либо уже Source.id, либо Chunk.id из search_sources.
 */
export async function resolveKbSourceId(sourceOrChunkId: string): Promise<string | null> {
  const asSource = await db.source.findUnique({
    where: { id: sourceOrChunkId },
    select: { id: true },
  });
  if (asSource) return asSource.id;

  const asChunk = await db.chunk.findUnique({
    where: { id: sourceOrChunkId },
    select: { sourceId: true },
  });
  return asChunk?.sourceId ?? null;
}
