// GET /api/kb/sources/[id]/chunks — list all chunks of a source
//
// Возвращает все chunks source в порядке position (для отображения в modal).
// GET chunks for a KB source (flat list with metadata).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const source = await db.source.findUnique({
      where: { id },
      select: { id: true, name: true, type: true, status: true, chunkCount: true },
    });

    if (!source) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const chunks = await db.chunk.findMany({
      where: { sourceId: id },
      orderBy: [{ parentId: 'asc' }, { position: 'asc' }],
      select: {
        id: true,
        content: true,
        metadata: true,
        position: true,
        parentId: true,
      },
    });

    return NextResponse.json({
      source: {
        id: source.id,
        name: source.name,
        type: source.type,
        status: source.status,
        chunkCount: source.chunkCount,
      },
      chunks: chunks.map(c => ({
        id: c.id,
        content: c.content,
        metadata: (() => {
          try { return JSON.parse(c.metadata); }
          catch { return { isComment: false }; }
        })(),
        position: c.position,
        parentId: c.parentId,
      })),
      totalCount: chunks.length,
    });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/sources/[id]/chunks failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
