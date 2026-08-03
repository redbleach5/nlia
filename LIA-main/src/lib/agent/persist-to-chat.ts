import 'server-only';

import { db } from '@/lib/db';
import { saveMessage } from '@/lib/memory/episodes';
import { logger } from '@/lib/logger';

export const AGENT_CANCELLED_CHAT_CONTENT = 'Задача отменена.';

export function agentFailedChatContent(error: string): string {
  return `Не удалось выполнить задачу.\n\n${error.trim() || 'unknown error'}`;
}

export async function persistAgentGoalToChat(
  episodeId: string,
  goal: string,
): Promise<string | null> {
  const text = goal.trim();
  if (!text) return null;
  try {
    const msg = await saveMessage(episodeId, { role: 'user', content: text });
    const { autoTitleEpisode } = await import('@/lib/memory/episodes');
    autoTitleEpisode(episodeId, text).catch((e) => {
      logger.warn('agent', 'autoTitleEpisode failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
    });
    return msg.id;
  } catch (e) {
    logger.warn('agent', 'Failed to persist agent goal to chat', { episodeId: episodeId.slice(0, 8) }, e);
    return null;
  }
}

export async function persistAgentResultToChat(
  task: { episodeId: string },
  content: string,
): Promise<string | null> {
  const text = content.trim();
  if (!text) return null;
  try {
    // Dedup: cancel/fail/backfill may race and try to write the same mirror twice.
    const existing = await db.message.findFirst({
      where: { episodeId: task.episodeId, role: 'companion', content: text },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing.id;

    const msg = await saveMessage(task.episodeId, { role: 'companion', content: text });
    return msg.id;
  } catch (e) {
    logger.warn('agent', 'Failed to persist agent result to chat', {
      episodeId: task.episodeId.slice(0, 8),
    }, e);
    return null;
  }
}

export async function emitTaskFailedToChat(
  task: { id: string; episodeId: string },
  error: string,
): Promise<void> {
  const { emitAgentEvent } = await import('./events');
  const chatMessageId = await persistAgentResultToChat(
    task,
    agentFailedChatContent(error),
  );
  emitAgentEvent({
    type: 'task_failed',
    taskId: task.id,
    error,
    ...(chatMessageId ? { chatMessageId } : {}),
    ts: Date.now(),
  });
}

export async function emitTaskCancelledToChat(
  task: { id: string; episodeId: string },
): Promise<void> {
  const { emitAgentEvent } = await import('./events');
  const chatMessageId = await persistAgentResultToChat(task, AGENT_CANCELLED_CHAT_CONTENT);
  emitAgentEvent({
    type: 'task_cancelled',
    taskId: task.id,
    ...(chatMessageId ? { chatMessageId } : {}),
    ts: Date.now(),
  });
}

/**
 * Repair chat history after restart / missed SSE: if an agent task finished
 * but its companion Message was never written, write it now.
 * Call on first-page episode load (no pagination cursor).
 */
export async function backfillAgentResultsToChat(episodeId: string): Promise<number> {
  try {
    const tasks = await db.agentTask.findMany({
      where: {
        episodeId,
        status: { in: ['done', 'failed', 'cancelled'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        resultSummary: true,
        error: true,
      },
    });
    if (tasks.length === 0) return 0;

    const companions = await db.message.findMany({
      where: { episodeId, role: 'companion' },
      select: { content: true },
    });
    const existing = new Set(companions.map(m => m.content.trim()));

    let written = 0;
    for (const t of tasks) {
      let content: string | null = null;
      if (t.status === 'done') {
        const summary = t.resultSummary?.trim();
        if (summary) content = summary;
      } else if (t.status === 'failed') {
        content = agentFailedChatContent(t.error ?? 'unknown error');
      } else if (t.status === 'cancelled') {
        content = AGENT_CANCELLED_CHAT_CONTENT;
      }
      if (!content || existing.has(content)) continue;

      const id = await persistAgentResultToChat({ episodeId }, content);
      if (id) {
        existing.add(content);
        written += 1;
      }
    }

    if (written > 0) {
      logger.info('agent', 'Backfilled agent results into chat', {
        episodeId: episodeId.slice(0, 8),
        written,
      });
    }
    return written;
  } catch (e) {
    logger.warn('agent', 'backfillAgentResultsToChat failed', {
      episodeId: episodeId.slice(0, 8),
    }, e);
    return 0;
  }
}
