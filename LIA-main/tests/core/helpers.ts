import { db } from '@/lib/db';
import { createAgentTask, type CreateAgentTaskInput, type AgentTaskStatus } from '@/lib/agent/task';

/** Create an isolated episode for core pipeline tests. Caller must delete in afterEach. */
export async function createTestEpisode(title = 'core-test'): Promise<string> {
  const episode = await db.episode.create({ data: { title } });
  return episode.id;
}

export async function deleteTestEpisode(episodeId: string): Promise<void> {
  await db.agentTask.deleteMany({ where: { episodeId } }).catch(() => null);
  await db.message.deleteMany({ where: { episodeId } }).catch(() => null);
  await db.episode.delete({ where: { id: episodeId } }).catch(() => null);
}

export async function readResponseBody(response: Response): Promise<string> {
  return response.text();
}

export async function getLatestCompanionMessage(episodeId: string): Promise<string | null> {
  const msg = await db.message.findFirst({
    where: { episodeId, role: 'companion' },
    orderBy: { createdAt: 'desc' },
  });
  return msg?.content ?? null;
}

export async function createTestAgentTask(
  episodeId: string,
  overrides: Partial<CreateAgentTaskInput> & {
    status?: AgentTaskStatus;
    checkpointJson?: string | null;
    planJson?: string | null;
    stepsJson?: string;
    currentStep?: number;
  } = {},
): Promise<string> {
  const { status, checkpointJson, planJson, stepsJson, currentStep, ...input } = overrides;
  const task = await createAgentTask({
    episodeId,
    goal: input.goal ?? 'Тестовая задача агента',
    maxSteps: input.maxSteps ?? 5,
    maxDurationSec: input.maxDurationSec ?? 600,
    ...input,
  });

  if (status || checkpointJson !== undefined || planJson !== undefined || stepsJson || currentStep !== undefined) {
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        ...(status ? { status } : {}),
        ...(checkpointJson !== undefined ? { checkpointJson } : {}),
        ...(planJson !== undefined ? { planJson } : {}),
        ...(stepsJson ? { stepsJson } : {}),
        ...(currentStep !== undefined ? { currentStep } : {}),
      },
    });
  }

  return task.id;
}

export async function getAgentTaskStatus(taskId: string): Promise<string | null> {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
  return task?.status ?? null;
}

export async function waitForTaskStatus(
  taskId: string,
  statuses: string[],
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getAgentTaskStatus(taskId);
    if (status && statuses.includes(status)) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Task ${taskId} did not reach status ${statuses.join('|')} within ${timeoutMs}ms`);
}
