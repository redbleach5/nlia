// GET  /api/episodes — list episodes
// POST /api/episodes — create new episode

import { NextRequest, NextResponse } from 'next/server';
import { listEpisodes, createEpisode } from '@/lib/memory/episodes';
import { logger } from '@/lib/logger';
import { parseBody, createEpisodeSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const episodes = await listEpisodes(50);
    return NextResponse.json({ episodes });
  } catch (e) {
    logger.error('api', 'GET failed', {}, e);
    return NextResponse.json({ error: 'failed to list episodes' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, createEpisodeSchema);
    if (!parsed.success) return parsed.response;
    const { title } = parsed.data;

    const episode = await createEpisode(title);
    return NextResponse.json({ episode }, { status: 201 });
  } catch (e) {
    logger.error('api', 'POST failed', {}, e);
    return NextResponse.json({ error: 'failed to create episode' }, { status: 500 });
  }
}
