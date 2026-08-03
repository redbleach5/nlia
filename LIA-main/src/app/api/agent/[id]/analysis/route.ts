import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseTaskError } from '@/lib/agent/error-analysis';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/agent/[id]/analysis
 *
 * Returns the smart error analysis (if available) for a failed agent task.
 * The analysis is generated asynchronously after task_failed event by
 * analyzeAndStoreFailure() in error-analysis.ts.
 *
 * Response shape:
 *   200: { taskId, status, goal, error: { message, analysis? } }
 *   404: task not found
 *   500: DB error
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const task = await db.agentTask.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        goal: true,
        error: true,
        completedAt: true,
      },
    });

    if (!task) {
      return apiError(404, 'Task not found', { taskId: id.slice(0, 16) });
    }

    const analyzed = parseTaskError(task.error);

    return NextResponse.json({
      taskId: task.id,
      status: task.status,
      goal: task.goal,
      error: analyzed,
      completedAt: task.completedAt,
    });
  } catch (e) {
    return apiError(500, 'Failed to fetch task analysis', {}, e);
  }
}
