// GET    /api/episodes/[id] — get episode with messages (cursor pagination)
// PATCH  /api/episodes/[id] — rename
// DELETE /api/episodes/[id] — delete

import { NextRequest, NextResponse } from 'next/server';
import { getEpisode, renameEpisode, deleteEpisode, getMessages } from '@/lib/memory/episodes';
import { logger } from '@/lib/logger';
import { parseBody, updateEpisodeSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const sp = req.nextUrl.searchParams;
    const limitRaw = parseInt(sp.get('limit') ?? String(DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(MAX_LIMIT, Math.max(1, limitRaw))
      : DEFAULT_LIMIT;

    const beforeCreatedAt = sp.get('beforeCreatedAt');
    const beforeId = sp.get('beforeId');
    let cursor: { createdAt: Date; id: string } | undefined;
    if (beforeCreatedAt && beforeId) {
      const createdAt = new Date(beforeCreatedAt);
      if (Number.isNaN(createdAt.getTime())) {
        return NextResponse.json({ error: 'invalid beforeCreatedAt' }, { status: 400 });
      }
      cursor = { createdAt, id: beforeId };
    } else if (beforeCreatedAt || beforeId) {
      return NextResponse.json(
        { error: 'beforeCreatedAt and beforeId are required together' },
        { status: 400 },
      );
    }

    // Fetch limit+1 to detect hasMore without a separate COUNT.
    // First page only: repair missing companion messages from finished agent tasks
    // (live UI can show SSE mirrors that never landed in Message rows).
    if (!cursor) {
      const { backfillAgentResultsToChat } = await import('@/lib/agent/persist-to-chat');
      await backfillAgentResultsToChat(id);
    }

    const batch = await getMessages(id, limit + 1, cursor);
    const hasMore = batch.length > limit;
    // getMessages returns chronological (old→new). Extra oldest row proves more history.
    const messages = hasMore ? batch.slice(1) : batch;
    const oldest = messages[0];
    const nextCursor = hasMore && oldest
      ? { createdAt: oldest.createdAt.toISOString(), id: oldest.id }
      : null;

    return NextResponse.json({ episode, messages, hasMore, nextCursor });
  } catch (e) {
    logger.error('api', 'episode GET failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const parsed = await parseBody(req, updateEpisodeSchema);
    if (!parsed.success) return parsed.response;
    const { title } = parsed.data;

    if (!title || title.trim().length === 0) {
      return NextResponse.json({ error: 'title required' }, { status: 400 });
    }

    await renameEpisode(id, title);
    const episode = await getEpisode(id);
    return NextResponse.json({ episode });
  } catch (e) {
    logger.error('api', 'episode PATCH failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteEpisode(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    logger.error('api', 'episode DELETE failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
