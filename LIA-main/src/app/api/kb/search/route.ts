// GET /api/kb/search — quick KB search для sidebar
//
// Query params: ?q=текст&limit=5
// Возвращает укороченные результаты (content truncated to 200 chars)
// для отображения в sidebar. Полный content — через GET /api/kb/sources/[id].
//
// Использует тот же searchKB pipeline что и agent tools, но с меньшим limit
// и truncation для sidebar UI.

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { searchKB } from '@/lib/kb/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '5', 10) || 5, 20);

    if (!q.trim()) {
      return NextResponse.json({ results: [], totalCount: 0 });
    }

    const results = await searchKB({ query: q, limit });

    return NextResponse.json({
      results: results.map(r => ({
        id: r.id,
        sourceId: r.sourceId,
        content: r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content,
        sourceName: r.sourceName,
        sourceType: r.sourceType,
        citation: r.citation,
        score: Math.round(r.score * 1000) / 1000,
        matchType: r.matchType,
      })),
      totalCount: results.length,
    });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/search failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
