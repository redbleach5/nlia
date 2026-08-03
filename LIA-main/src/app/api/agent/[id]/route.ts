// GET /api/agent/[id] — task details with parsed steps + artifacts

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, parseSteps, parseArtifacts } from '@/lib/agent/task';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    // Безопасный parse planJson — может быть повреждён в БД.
    // parseSteps/parseArtifacts уже имеют try/catch внутри, но planJson парсился напрямую.
    let plan: unknown = null;
    if (task.planJson) {
      try {
        plan = JSON.parse(task.planJson);
      } catch (e) {
        logger.warn('agent', 'planJson parse failed — returning null', { taskId: id.slice(0, 8) }, e);
        plan = null;
      }
    }

    return NextResponse.json({
      task,
      steps: parseSteps(task.stepsJson),
      artifacts: parseArtifacts(task.artifactsJson),
      plan,
    });
  } catch (e) {
    logger.error('agent', '] GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
