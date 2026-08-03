// POST /api/agent/[id]/file-apply — Apply / Reject / Apply-all pending edits.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAgentTask } from '@/lib/agent/task';
import {
  applyAllPendingChanges,
  applyFileChange,
  rejectFileChange,
} from '@/lib/agent/file-changes';
import { parseBody } from '@/lib/infra/api-validation';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.union([
  z.object({
    all: z.literal(true),
  }),
  z.object({
    changeId: z.string().min(1).max(80),
    reject: z.boolean().optional(),
  }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const parsed = await parseBody(req, schema);
    if (!parsed.success) return parsed.response;

    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if ('all' in parsed.data && parsed.data.all === true) {
      const result = await applyAllPendingChanges(id, task.fsScope);
      log.info('agent', 'file-apply-all', {
        applied: result.applied.length,
        failed: result.failed.length,
      });
      return NextResponse.json(result);
    }

    const { changeId, reject } = parsed.data as { changeId: string; reject?: boolean };
    if (reject) {
      const result = await rejectFileChange(id, changeId);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, path: result.path, rejected: true });
    }

    const result = await applyFileChange(id, changeId, task.fsScope);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    log.info('agent', 'file-apply ok', { path: result.path });
    return NextResponse.json({ ok: true, path: result.path });
  } catch (e) {
    log.error('agent', '/file-apply failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
