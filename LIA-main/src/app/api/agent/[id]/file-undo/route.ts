// POST /api/agent/[id]/file-undo — restore previous content for a recorded file_changed.
// Body: { changeId } for one change, or { all: true } for LIFO undo-all.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAgentTask } from '@/lib/agent/task';
import { undoAllFileChanges, undoFileChange } from '@/lib/agent/file-changes';
import { parseBody } from '@/lib/infra/api-validation';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fileUndoSchema = z.union([
  z.object({
    changeId: z.string().min(1).max(80),
    all: z.literal(true).optional(),
  }),
  z.object({
    all: z.literal(true),
    changeId: z.undefined().optional(),
  }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const parsed = await parseBody(req, fileUndoSchema);
    if (!parsed.success) return parsed.response;

    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if ('all' in parsed.data && parsed.data.all === true) {
      const result = await undoAllFileChanges(id, task.fsScope);
      log.info('agent', 'file-undo-all ok', {
        undone: result.undone.length,
        skipped: result.skipped.length,
      });
      return NextResponse.json(result);
    }

    const changeId = 'changeId' in parsed.data ? parsed.data.changeId : undefined;
    if (!changeId) {
      return NextResponse.json({ error: 'changeId or all required' }, { status: 400 });
    }

    const result = await undoFileChange(id, changeId, task.fsScope);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    log.info('agent', 'file-undo ok', { path: result.path });
    return NextResponse.json({ ok: true, path: result.path });
  } catch (e) {
    log.error('agent', '/file-undo failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
