import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '@/lib/paths';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/chat/attachments/[id]?episodeId= — preview/download linked or pending file */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const episodeId = req.nextUrl.searchParams.get('episodeId');
  if (!episodeId) {
    return NextResponse.json({ error: 'episodeId required' }, { status: 400 });
  }

  const row = await db.chatAttachment.findFirst({
    where: { id, episodeId },
  });
  if (!row) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const buf = await readFile(join(PATHS.artifacts, row.storageKey));
    return new Response(buf, {
      headers: {
        'Content-Type': row.mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(row.originalName)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'file missing' }, { status: 404 });
  }
}
