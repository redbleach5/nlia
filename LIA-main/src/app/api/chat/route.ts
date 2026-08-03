// POST /api/chat — adaptive streaming chat.
//
// Thin handler: zod validate → runChatPipeline → stream response.
// Agent routing lives only in the client → POST /api/agent (single authority).
// Do not auto-create agent tasks here: that duplicated sandbox policy and
// silently confirmed write sandboxes without the 409 confirm UI.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runChatPipeline } from '@/lib/chat/pipeline';
import { parseBody, chatRequestSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, chatRequestSchema);
  if (!parsed.success) return parsed.response;
  const { text, episodeId, mode, attachmentIds } = parsed.data;

  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) {
    return NextResponse.json({ error: 'episode not found' }, { status: 404 });
  }

  // req.signal — Stop button aborts the server-side LLM call.
  const result = await runChatPipeline({
    text: text.trim(),
    episodeId,
    mode,
    attachmentIds,
    abortSignal: req.signal,
  });
  if (result instanceof NextResponse) {
    return result;
  }
  return result.response;
}
