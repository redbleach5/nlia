// POST /api/agent/[id]/input — ответ пользователя на ask_user / pause.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { resolveWaiting, isWaiting } from '@/lib/agent/events';
import { logger } from '@/lib/logger';
import { parseBody, agentInputSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const parsed = await parseBody(req, agentInputSchema);
    if (!parsed.success) return parsed.response;
    const { answer } = parsed.data;

    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (task.status !== 'waiting_input') {
      return NextResponse.json({
        error: `task is ${task.status}, not waiting_input`,
        currentStatus: task.status,
      }, { status: 400 });
    }

    if (!isWaiting(id)) {
      log.error('agent', 'Input rejected — in-memory waiting state lost', {
        dbStatus: task.status,
      });
      return NextResponse.json({
        error: 'waiting state lost',
        message: 'Сессия ожидания потеряна (перезапуск сервера). Запустите задачу снова — вопрос восстановится из checkpoint.',
        restartUrl: `/api/agent/${id}/start`,
      }, { status: 409 });
    }

    const ok = resolveWaiting(id, answer);
    if (!ok) {
      return NextResponse.json({ error: 'failed to resolve' }, { status: 500 });
    }

    log.info('agent', `Input accepted: "${answer.slice(0, 80)}"`);
    await updateAgentTask(id, { status: 'executing' });

    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error('agent', '/input failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
