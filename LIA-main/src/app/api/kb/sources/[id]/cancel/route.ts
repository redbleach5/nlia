// POST /api/kb/sources/[id]/cancel — cancel ongoing indexing
//
// Использует AbortController (см. indexer.ts) для отмены indexer'а.
// Idempotent: если indexing не идёт — no-op, возвращает ok.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { abortIndexing, isIndexing } from '@/lib/kb/indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const source = await db.source.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (!isIndexing(id)) {
      return NextResponse.json({
        ok: true,
        message: 'No indexing in progress for this source.',
      });
    }

    abortIndexing(id);

    logger.info('kb', 'Cancel indexing requested', { sourceId: id.slice(0, 8) });
    return NextResponse.json({
      ok: true,
      message: 'Indexing cancellation requested. Source will return to idle status.',
    });
  } catch (e) {
    logger.error('kb', 'POST /api/kb/sources/[id]/cancel failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
