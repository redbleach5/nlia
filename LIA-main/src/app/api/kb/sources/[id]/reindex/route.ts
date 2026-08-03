// POST /api/kb/sources/[id]/reindex — trigger re-indexing of a source
//
// Phase 2: запускает indexDocumentSource() для document.
// Reindex document/folder/url/codebase sources.
// Indexing идёт в фоне. Прогресс — через polling GET /api/kb/sources.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { indexDocumentSource, abortIndexing, isIndexing } from '@/lib/kb/indexer';
import { indexFolderSource, indexFolderSourceFull } from '@/lib/kb/folder-indexer';
import { indexCodebaseSource } from '@/lib/kb/code-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const mode = req.nextUrl.searchParams.get('mode');
  try {
    const source = await db.source.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    // Cancel in-flight indexing when supported (document / folder / codebase).
    if (source.type === 'document' && isIndexing(id)) {
      abortIndexing(id);
    }
    if (source.type === 'folder' && isIndexing(id)) {
      abortIndexing(id);
    }
    if (source.type === 'codebase' && isIndexing(id)) {
      abortIndexing(id);
    }

    if (source.type === 'document') {
      // Start indexing in background (non-blocking)
      indexDocumentSource(id).catch((e) => {
        logger.error('kb', 'Background reindex failed', { sourceId: id }, e);
      });

      return NextResponse.json({
        ok: true,
        message: 'Indexing started in background. Poll GET /api/kb/sources for status.',
        sourceId: id,
      });
    } else if (source.type === 'folder') {
      const indexer = mode === 'full' ? indexFolderSourceFull : indexFolderSource;
      indexer(id).catch((e) => {
        logger.error('kb', 'Background folder reindex failed', { sourceId: id }, e);
      });

      return NextResponse.json({
        ok: true,
        message: mode === 'full'
          ? 'Full folder indexing started (embed all files). Poll GET /api/kb/sources for status.'
          : 'Folder catalog indexing started (names only). Poll GET /api/kb/sources for status.',
        sourceId: id,
        mode: mode === 'full' ? 'full' : 'manifest',
      });
    } else if (source.type === 'codebase') {
      indexCodebaseSource(id).catch((e) => {
        logger.error('kb', 'Background codebase reindex failed', { sourceId: id }, e);
      });

      return NextResponse.json({
        ok: true,
        message: 'Codebase indexing started in background. Poll GET /api/kb/sources for status.',
        sourceId: id,
      });
    } else if (source.type === 'url') {
      // Phase 7: URL re-index (re-fetch + re-extract)
      const { indexUrlSource } = await import('@/lib/kb/indexer');
      indexUrlSource(id).catch((e) => {
        logger.error('kb', 'Background URL reindex failed', { sourceId: id }, e);
      });

      return NextResponse.json({
        ok: true,
        message: 'URL re-indexing started in background. Poll GET /api/kb/sources for status.',
        sourceId: id,
      });
    } else {
      return NextResponse.json(
        { error: `unsupported source type: ${source.type}` },
        { status: 400 },
      );
    }
  } catch (e) {
    logger.error('kb', 'POST /api/kb/sources/[id]/reindex failed', { id: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
