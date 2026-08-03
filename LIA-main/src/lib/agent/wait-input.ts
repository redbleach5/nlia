import 'server-only';

import { updateAgentTask, getAgentTask } from './task';
import { emitAgentEvent, setWaiting, isCancelled, cancelWaiting } from './events';
import { logger } from '@/lib/logger';

export type AgentCheckpoint = {
  plan: {
    goal: string;
    steps: string[];
    needsTools: boolean;
    complexity: 'low' | 'medium' | 'high';
    targetFiles?: string[];
  };
  steps: Array<{ thought: string; action: string; input: unknown; observation: string; ts: number; durationMs?: number }>;
  savedAt: number;
  pendingQuestion?: string;
};

const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;

async function markWaitingForInput(taskId: string, question: string): Promise<void> {
  const task = await getAgentTask(taskId);
  let checkpoint: AgentCheckpoint | Record<string, unknown> = {};
  if (task?.checkpointJson) {
    try {
      checkpoint = JSON.parse(task.checkpointJson) as AgentCheckpoint;
    } catch { /* fresh checkpoint */ }
  }
  checkpoint.pendingQuestion = question;

  await updateAgentTask(taskId, {
    status: 'waiting_input',
    checkpointJson: JSON.stringify(checkpoint),
  });

  const event = { type: 'task_waiting_input' as const, taskId, question, ts: Date.now() };
  emitAgentEvent(event);
}

async function clearPendingQuestion(taskId: string): Promise<void> {
  const task = await getAgentTask(taskId);
  if (!task?.checkpointJson) return;
  try {
    const checkpoint = JSON.parse(task.checkpointJson) as AgentCheckpoint;
    delete checkpoint.pendingQuestion;
    await updateAgentTask(taskId, { checkpointJson: JSON.stringify(checkpoint) });
  } catch { /* non-fatal */ }
}

function waitForUserAnswer(taskId: string, question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cleanupHandles: { interval?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      if (cleanupHandles.interval) clearInterval(cleanupHandles.interval);
      if (cleanupHandles.timeout) clearTimeout(cleanupHandles.timeout);
    };

    setWaiting(taskId, {
      question,
      resolve: (answer: string) => {
        cleanup();
        resolve(answer);
      },
      reject: (err: Error) => {
        cleanup();
        reject(err);
      },
    });

    cleanupHandles.interval = setInterval(() => {
      if (isCancelled(taskId)) {
        cleanup();
        cancelWaiting(taskId);
        reject(new Error('cancelled'));
      }
    }, 500);

    cleanupHandles.timeout = setTimeout(() => {
      cleanup();
      cancelWaiting(taskId);
      reject(new Error(`timeout: user did not respond within ${ASK_USER_TIMEOUT_MS / 60000} minutes`));
    }, ASK_USER_TIMEOUT_MS);
    cleanupHandles.timeout.unref?.();
    cleanupHandles.interval.unref?.();
  });
}

export async function waitForUserInput(taskId: string, question: string): Promise<string> {
  logger.info('agent', 'Waiting for user input', {
    taskId: taskId.slice(0, 8),
    question: question.slice(0, 100),
  });

  await markWaitingForInput(taskId, question);

  try {
    const answer = await waitForUserAnswer(taskId, question);
    await clearPendingQuestion(taskId);
    await updateAgentTask(taskId, { status: 'executing' }).catch(() => null);
    logger.info('agent', 'User answered', {
      taskId: taskId.slice(0, 8),
      answerPreview: answer.slice(0, 80),
    });
    return answer;
  } catch (e) {
    await clearPendingQuestion(taskId);
    throw e;
  }
}
