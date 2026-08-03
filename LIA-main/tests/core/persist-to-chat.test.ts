import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const saveMessage = vi.fn();
vi.mock('@/lib/memory/episodes', () => ({
  saveMessage: (...args: unknown[]) => saveMessage(...args),
  autoTitleEpisode: vi.fn().mockResolvedValue(undefined),
}));

const findFirst = vi.fn();
const findManyMessages = vi.fn();
const findManyTasks = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    message: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      findMany: (...args: unknown[]) => findManyMessages(...args),
    },
    agentTask: {
      findMany: (...args: unknown[]) => findManyTasks(...args),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const emitAgentEvent = vi.fn();
vi.mock('@/lib/agent/events', () => ({
  emitAgentEvent: (...args: unknown[]) => emitAgentEvent(...args),
}));

describe('persist-to-chat', () => {
  beforeEach(() => {
    saveMessage.mockReset();
    emitAgentEvent.mockReset();
    findFirst.mockReset();
    findManyMessages.mockReset();
    findManyTasks.mockReset();
    saveMessage.mockResolvedValue({ id: 'msg-1' });
    findFirst.mockResolvedValue(null);
  });

  it('persistAgentGoalToChat writes a user message', async () => {
    const { persistAgentGoalToChat } = await import('@/lib/agent/persist-to-chat');
    const id = await persistAgentGoalToChat('ep-1', '  найти EGTS  ');
    expect(id).toBe('msg-1');
    expect(saveMessage).toHaveBeenCalledWith('ep-1', { role: 'user', content: 'найти EGTS' });
  });

  it('persistAgentResultToChat writes companion message', async () => {
    const { persistAgentResultToChat } = await import('@/lib/agent/persist-to-chat');
    const id = await persistAgentResultToChat({ episodeId: 'ep-1' }, 'итог');
    expect(id).toBe('msg-1');
    expect(saveMessage).toHaveBeenCalledWith('ep-1', { role: 'companion', content: 'итог' });
  });

  it('persistAgentResultToChat reuses existing companion with same content', async () => {
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    const { persistAgentResultToChat } = await import('@/lib/agent/persist-to-chat');
    const id = await persistAgentResultToChat({ episodeId: 'ep-1' }, 'итог');
    expect(id).toBe('existing');
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('backfillAgentResultsToChat writes missing done/failed/cancelled mirrors', async () => {
    findManyTasks.mockResolvedValueOnce([
      { id: 't1', status: 'done', resultSummary: 'готово', error: null },
      { id: 't2', status: 'cancelled', resultSummary: null, error: null },
      { id: 't3', status: 'failed', resultSummary: null, error: 'boom' },
    ]);
    findManyMessages.mockResolvedValueOnce([]);
    findFirst.mockResolvedValue(null);
    saveMessage
      .mockResolvedValueOnce({ id: 'm1' })
      .mockResolvedValueOnce({ id: 'm2' })
      .mockResolvedValueOnce({ id: 'm3' });

    const { backfillAgentResultsToChat } = await import('@/lib/agent/persist-to-chat');
    const n = await backfillAgentResultsToChat('ep-1');
    expect(n).toBe(3);
    expect(saveMessage).toHaveBeenCalledTimes(3);
  });
});
