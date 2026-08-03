// GET /api/kb/recent — recently updated KB sources (for sidebar)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10) || 10, 50);

    const sources = await db.source.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        chunkCount: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      recent: sources.map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
        chunkCount: s.chunkCount,
        updatedAt: s.updatedAt.toISOString(),
      })),
      totalCount: sources.length,
    });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/recent failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
