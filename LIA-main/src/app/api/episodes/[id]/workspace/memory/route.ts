// GET    /api/episodes/[id]/workspace/memory — list durable facts for bound workspace
// DELETE /api/episodes/[id]/workspace/memory — clear all facts for this fingerprint
// POST   /api/episodes/[id]/workspace/memory — upsert one fact { shortKey, value }

import { NextRequest, NextResponse } from 'next/server';
import { getEpisode } from '@/lib/memory/episodes';
import { getEpisodeWorkspace } from '@/lib/agent/workspace-binding';
import {
  workspaceFingerprint,
  listWorkspaceMemory,
  clearWorkspaceMemory,
  upsertWorkspaceMemoryFact,
  bootstrapWorkspaceMemory,
} from '@/lib/agent/workspace-memory';
import { parseBody } from '@/lib/infra/api-validation';
import { z } from 'zod';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const upsertSchema = z.object({
  shortKey: z.string().min(1).max(40),
  value: z.string().min(1).max(500),
});

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
    const fingerprint = workspaceFingerprint(binding);
    if (!binding || !fingerprint) {
      return NextResponse.json({
        binding: null,
        fingerprint: null,
        facts: [],
      });
    }
    const facts = await listWorkspaceMemory(fingerprint);
    return NextResponse.json({
      binding: { kind: binding.kind, label: binding.label },
      fingerprint,
      facts,
    });
  } catch (e) {
    logger.error('api', 'GET workspace memory failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const binding = await getEpisodeWorkspace(id);
    const fingerprint = workspaceFingerprint(binding);
    if (!binding || !fingerprint) {
      return NextResponse.json({ error: 'no workspace bound' }, { status: 400 });
    }

    const parsed = await parseBody(req, upsertSchema);
    if (!parsed.success) return parsed.response;

    // Reserved keys from bootstrap — allow overwrite
    await upsertWorkspaceMemoryFact(fingerprint, parsed.data.shortKey, parsed.data.value);
    const facts = await listWorkspaceMemory(fingerprint);
    return NextResponse.json({ fingerprint, facts });
  } catch (e) {
    logger.error('api', 'POST workspace memory failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
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
    const binding = await getEpisodeWorkspace(id);
    const fingerprint = workspaceFingerprint(binding);
    if (!binding || !fingerprint) {
      return NextResponse.json({ cleared: 0, fingerprint: null });
    }
    const cleared = await clearWorkspaceMemory(fingerprint);
    // Re-seed label/kind/path so prompt still has a baseline
    await bootstrapWorkspaceMemory(binding);
    const facts = await listWorkspaceMemory(fingerprint);
    return NextResponse.json({ cleared, fingerprint, facts });
  } catch (e) {
    logger.error('api', 'DELETE workspace memory failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
