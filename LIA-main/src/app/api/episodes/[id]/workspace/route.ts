// GET    /api/episodes/[id]/workspace — current binding
// PUT    /api/episodes/[id]/workspace — set binding
// DELETE /api/episodes/[id]/workspace — clear

import { NextRequest, NextResponse } from 'next/server';
import { getEpisode } from '@/lib/memory/episodes';
import {
  getEpisodeWorkspace,
  setEpisodeWorkspace,
  resolveFsPathFromSources,
} from '@/lib/agent/workspace-binding';
import { parseBody, upsertEpisodeWorkspaceSchema } from '@/lib/infra/api-validation';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const binding = await getEpisodeWorkspace(id);
    const envDefault = (process.env.LIA_AGENT_DEFAULT_WORKSPACE || '').trim() || null;
    return NextResponse.json({ binding, envDefault });
  } catch (e) {
    logger.error('api', 'GET workspace failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const parsed = await parseBody(req, upsertEpisodeWorkspaceSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    let label = body.label;
    let fsPath = body.fsPath ?? null;
    let sourceIds = body.sourceIds ?? [];

    if (body.kind === 'kb') {
      if (sourceIds.length === 0) {
        return NextResponse.json({ error: 'sourceIds required for kind=kb' }, { status: 400 });
      }
      const sources = await db.source.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, name: true, status: true, type: true },
      });
      if (sources.length === 0) {
        return NextResponse.json({ error: 'sources not found' }, { status: 404 });
      }
      if (!label) {
        label = sources.length === 1
          ? sources[0].name
          : sources.map((s) => s.name).join(', ').slice(0, 120);
      }
      if (!fsPath) {
        fsPath = await resolveFsPathFromSources(sourceIds);
      }
    }

    if (body.kind === 'project') {
      if (!fsPath?.trim()) {
        return NextResponse.json({ error: 'fsPath required for kind=project' }, { status: 400 });
      }
    }

    const binding = await setEpisodeWorkspace(id, {
      kind: body.kind,
      fsPath,
      sourceIds,
      label,
      pinKb: body.pinKb,
    });

    return NextResponse.json({ binding });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'failed';
    logger.error('api', 'PUT workspace failed', { episodeId: id.slice(0, 8), message }, e);
    const status = /не найдена|required|нужен/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    await setEpisodeWorkspace(id, null);
    return NextResponse.json({ binding: null });
  } catch (e) {
    logger.error('api', 'DELETE workspace failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
