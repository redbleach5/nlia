// POST /api/agent/[id]/cancel — cancel a running task.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { cancelAgentTaskRun, isRunning } from '@/lib/agent/runner';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
      return NextResponse.json({ error: `task already ${task.status}` }, { status: 400 });
    }

    if (isRunning(id)) {
      await cancelAgentTaskRun(id);
    } else {
      await updateAgentTask(id, {
        status: 'cancelled',
        completedAt: new Date(),
      });
    }

    const updated = await getAgentTask(id);
    return NextResponse.json({ task: updated });
  } catch (e) {
    logger.error('agent', '/cancel failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
