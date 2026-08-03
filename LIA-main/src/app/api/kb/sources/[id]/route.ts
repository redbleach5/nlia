// GET    /api/kb/sources/[id]
// PATCH  /api/kb/sources/[id]
// DELETE /api/kb/sources/[id]

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseBody, updateKbSourceSchema } from '@/lib/infra/api-validation';
import { deleteKbVectorsForSource } from '@/lib/kb/db-vec-kb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const source = await db.source.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ source });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/sources/[id] failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const parsed = await parseBody(req, updateKbSourceSchema);
    if (!parsed.success) return parsed.response;
    const { name, status, config } = parsed.data;

    const existing = await db.source.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const update: { name?: string; status?: string; config?: string } = {};
    if (name !== undefined) update.name = name;
    if (status !== undefined) update.status = status;
    if (config !== undefined) {
      update.config = JSON.stringify(config);
    }

    const updated = await db.source.update({ where: { id }, data: update });
    logger.info('kb', 'Source updated', { sourceId: id, fields: Object.keys(update) });
    return NextResponse.json({ source: updated });
  } catch (e) {
    logger.error('kb', 'PATCH /api/kb/sources/[id] failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const existing = await db.source.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    try {
      deleteKbVectorsForSource(id);
      const { removeSourceFromInvertedIndex } = await import('@/lib/kb/inverted-index');
      removeSourceFromInvertedIndex(id);
    } catch (idxErr) {
      logger.error('kb', 'DELETE source: failed to delete KB indexes, source kept in DB', {
        id: id.slice(0, 8),
      }, idxErr);
      return NextResponse.json(
        { error: 'failed to delete KB indexes, source kept for retry' },
        { status: 500 },
      );
    }

    await db.source.delete({ where: { id } });

    logger.info('kb', 'Source deleted', {
      sourceId: id,
      type: existing.type,
      name: existing.name,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logger.error('kb', 'DELETE /api/kb/sources/[id] failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
