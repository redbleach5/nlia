// GET/POST /api/agent/[id]/runtime — Process Supervisor control for Studio UI.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAgentTask } from '@/lib/agent/task';
import {
  getRuntimeLogs,
  getRuntimeSnapshot,
  startRuntimeFromDesign,
  stopRuntime,
} from '@/lib/agent/runtime/process-supervisor';
import { parseProjectDesignJson, PROJECT_MANIFEST_FILENAME } from '@/lib/agent/runtime/project-manifest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const postSchema = z.object({
  action: z.enum(['stop', 'restart']),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const task = await getAgentTask(id);
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let design = null;
  if (task.fsScope) {
    try {
      const text = await readFile(join(task.fsScope, PROJECT_MANIFEST_FILENAME), 'utf8');
      const parsed = parseProjectDesignJson(text);
      if (parsed.ok) design = parsed.design;
    } catch {
      /* no manifest yet */
    }
  }

  let snapshot = getRuntimeSnapshot(id);
  // Do NOT invent "healthy" just because design.port answers TCP.
  // Leftover `serve` from a previous sandbox often still owns :5173 and would
  // make Preview show the wrong artifact after a new task starts / F5.

  return NextResponse.json({
    snapshot,
    logs: getRuntimeLogs(id, 120),
    design,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await getAgentTask(id);
    if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const body = postSchema.parse(await req.json());
    if (body.action === 'stop') {
      const result = await stopRuntime(id);
      return NextResponse.json({ ok: true, ...result, snapshot: getRuntimeSnapshot(id) });
    }

    // restart
    if (!task.fsScope) {
      return NextResponse.json({ error: 'no fsScope' }, { status: 400 });
    }
    let designJson: string;
    try {
      designJson = await readFile(join(task.fsScope, PROJECT_MANIFEST_FILENAME), 'utf8');
    } catch {
      return NextResponse.json({ error: `${PROJECT_MANIFEST_FILENAME} missing` }, { status: 400 });
    }
    const parsed = parseProjectDesignJson(designJson);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    await stopRuntime(id);
    const started = await startRuntimeFromDesign(id, task.fsScope, parsed.design, 'dev');
    return NextResponse.json({
      ok: started.success,
      ...started,
      snapshot: getRuntimeSnapshot(id),
    });
  } catch (e) {
    logger.error('agent', '/runtime failed', {}, e);
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    }
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
