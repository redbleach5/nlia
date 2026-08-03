import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests for src/lib/memory/summarization.ts
 *
 * Tests conversation summarization:
 *   - shouldSummarizeEpisode: boundary detection (every N messages)
 *   - summarizeEpisode: LLM call + persistence with [summarized@N] prefix
 *   - getEpisodeSummary: strips prefix
 *
 * Mocks:
 *   - @/lib/ollama.getChatModel — mock model
 *   - ai.generateText — returns canned summary
 *   - @/lib/db — in-memory episode + message tables
 */

vi.mock('@/lib/ollama', () => ({
  getChatModel: vi.fn(async () => ({ modelId: 'mock-model' })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: mockGenerateText };
});

// In-memory episode + message store
let mockEpisodes: Map<string, {
  summary: string | null;
  _count: { messages: number };
}> = new Map();

let mockMessages: Array<{ role: string; content: string; createdAt: Date }> = [];

const mockDb = {
  episode: {
    findUnique: vi.fn(async ({ where, select }: {
      where: { id: string };
      select?: {
        summary?: boolean;
        _count?: unknown;
        messages?: boolean | {
          orderBy?: { createdAt?: 'asc' | 'desc' };
          take?: number;
          skip?: number;
        };
        updatedAt?: boolean;
      };
    }) => {
      const ep = mockEpisodes.get(where.id);
      if (!ep) return null;
      const result: any = {};
      // Handle both `_count: true` and `_count: { select: { messages: true } }`
      if (select?._count !== undefined) {
        result._count = { messages: ep._count.messages };
      }
      if (select?.summary !== undefined) result.summary = ep.summary;
      if (select?.messages) {
        // P-CORE-1 test: honor orderBy + take so we can verify the fix
        // (previously the mock ignored them, masking the orderBy bug).
        let msgs = [...mockMessages];
        const msgSelect = typeof select.messages === 'object' ? select.messages : undefined;
        if (msgSelect?.orderBy?.createdAt === 'desc') {
          msgs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        } else {
          msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        }
        if (msgSelect?.skip) msgs = msgs.slice(msgSelect.skip);
        if (msgSelect?.take) msgs = msgs.slice(0, msgSelect.take);
        result.messages = msgs.map(m => ({ role: m.role, content: m.content }));
      }
      if (select?.updatedAt !== undefined) result.updatedAt = new Date();
      return result;
    }),
    update: vi.fn(async ({ where, data }: {
      where: { id: string };
      data: { summary?: string };
    }) => {
      const ep = mockEpisodes.get(where.id);
      if (ep && data.summary !== undefined) ep.summary = data.summary;
      return {};
    }),
  },
};
vi.mock('@/lib/db', () => ({ db: mockDb }));

describe('memory/summarization: shouldSummarizeEpisode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEpisodes.clear();
    mockMessages = [];
  });

  it('returns false when episode not found', async () => {
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('nonexistent');
    expect(result).toBe(false);
  });

  it('returns false when fewer than 20 messages', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 5 } });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(false);
  });

  it('returns true at 20 messages with no existing summary', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 20 } });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(true);
  });

  it('returns false right after summarization (boundary not crossed)', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@20] Some summary text',
      _count: { messages: 25 },
    });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(false);
  });

  it('returns true at 40 messages after summarization at 20', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@20] Some summary text',
      _count: { messages: 40 },
    });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(true);
  });

  it('returns true at 60 messages after summarization at 40', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@40] Updated summary',
      _count: { messages: 60 },
    });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(true);
  });

  it('handles corrupt summary prefix gracefully', async () => {
    // Summary without [summarized@N] prefix — should treat as 0 and summarize
    mockEpisodes.set('ep1', {
      summary: 'Some legacy summary without prefix',
      _count: { messages: 25 },
    });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    const result = await shouldSummarizeEpisode('ep1');
    expect(result).toBe(true);  // 25 >= 0 + 20
  });

  it('under budget pressure: true at 8 messages with no summary', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 8 } });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    expect(await shouldSummarizeEpisode('ep1', { budgetPressured: true })).toBe(true);
    expect(await shouldSummarizeEpisode('ep1')).toBe(false);
  });

  it('under budget pressure: re-summarize every 8 after last', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@20] Some summary',
      _count: { messages: 28 },
    });
    const { shouldSummarizeEpisode } = await import('@/lib/memory/summarization');
    expect(await shouldSummarizeEpisode('ep1', { budgetPressured: true })).toBe(true);
    expect(await shouldSummarizeEpisode('ep1')).toBe(false); // 28 < 20+20
  });
});

describe('memory/summarization: summarizeEpisode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEpisodes.clear();
    mockMessages = [];
    mockGenerateText.mockReset();
  });

  it('does nothing when episode not found', async () => {
    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('nonexistent');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.episode.update).not.toHaveBeenCalled();
  });

  it('does nothing when fewer than 8 messages', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 5 } });
    mockMessages = [
      { role: 'user', content: 'hi', createdAt: new Date() },
    ];
    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('generates summary and persists with [summarized@N] prefix', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 20 } });
    mockMessages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'companion',
      content: `Message ${i}`,
      createdAt: new Date(),
    }));

    mockGenerateText.mockResolvedValue({
      text: 'Пользователь обсуждал тестирование с Лией.',
      usage: { promptTokens: 200, completionTokens: 50 },
      finishReason: 'stop',
    } as any);

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockDb.episode.update).toHaveBeenCalledTimes(1);
    const updateCall = mockDb.episode.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe('ep1');
    expect(updateCall.data.summary).toMatch(/^\[summarized@20\] /);
    expect(updateCall.data.summary).toContain('Пользователь обсуждал');
  });

  it('includes existing summary in LLM prompt when updating', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@20] Initial summary about Python',
      _count: { messages: 40 },
    });
    mockMessages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'companion',
      content: `Message ${i} about testing`,
      createdAt: new Date(),
    }));

    mockGenerateText.mockResolvedValue({
      text: 'Updated summary covering Python and testing.',
      usage: { promptTokens: 300, completionTokens: 60 },
      finishReason: 'stop',
    } as any);

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');

    const prompt = mockGenerateText.mock.calls[0][0].prompt;
    // Existing summary (without prefix) should be in the prompt
    expect(prompt).toContain('Initial summary about Python');
    expect(prompt).toContain('ТЕКУЩЕЕ САММАРИ');
  });

  // P-CORE-1 regression: previously `orderBy: 'asc'` + `take: 30` returned
  // the OLDEST 30 messages — the prompt said "ПОСЛЕДНИЕ СООБЩЕНИЯ" but the
  // code did the opposite. For a 100-message episode the summary was built
  // on messages 1-30 and missed the recent context entirely.
  it('P-CORE-1: uses NEWEST N messages, not oldest N', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 50 } });
    // 50 messages with distinct content. createdAt increases with index.
    // With orderBy desc + take 30, we should get messages 49..20 (newest 30).
    // With the bug (orderBy asc + take 30), we'd get messages 0..29 (oldest 30).
    mockMessages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'companion',
      content: `UNIQUE_MSG_${i}`,
      createdAt: new Date(2026, 0, 1, 0, 0, i),  // distinct, increasing
    }));

    mockGenerateText.mockResolvedValue({
      text: 'Summary of recent messages.',
      usage: { promptTokens: 300, completionTokens: 60 },
      finishReason: 'stop',
    } as any);

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    // Newest message (index 49) MUST be in the prompt.
    expect(prompt).toContain('UNIQUE_MSG_49');
    // Message 25 — should be in the prompt (it's within the newest 30: indices 20-49).
    expect(prompt).toContain('UNIQUE_MSG_25');
    // Message 5 — should NOT be in the prompt (it's in the oldest 20, which
    // the bug would have included).
    expect(prompt).not.toContain('UNIQUE_MSG_5');
    // Message 0 — definitely should not be in the prompt.
    expect(prompt).not.toContain('UNIQUE_MSG_0');
  });

  it('does not persist when LLM returns empty text', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 20 } });
    mockMessages = [{ role: 'user', content: 'test', createdAt: new Date() }];

    mockGenerateText.mockResolvedValue({
      text: '',
      usage: { promptTokens: 100, completionTokens: 0 },
      finishReason: 'stop',
    } as any);

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');

    expect(mockDb.episode.update).not.toHaveBeenCalled();
  });

  it('does not throw when LLM call fails', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 20 } });
    mockMessages = [{ role: 'user', content: 'test', createdAt: new Date() }];

    mockGenerateText.mockRejectedValue(new Error('LLM unavailable'));

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    // Should not throw
    await expect(summarizeEpisode('ep1')).resolves.toBeUndefined();
    expect(mockDb.episode.update).not.toHaveBeenCalled();
  });

  it('truncates summary to max chars', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 20 } });
    mockMessages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'companion',
      content: `Message ${i}`,
      createdAt: new Date(),
    }));

    const longSummary = 'А'.repeat(2000);  // exceeds MAX_SUMMARY_CHARS=1500
    mockGenerateText.mockResolvedValue({
      text: longSummary,
      usage: { promptTokens: 100, completionTokens: 200 },
      finishReason: 'stop',
    } as any);

    const { summarizeEpisode } = await import('@/lib/memory/summarization');
    await summarizeEpisode('ep1');

    expect(mockDb.episode.update).toHaveBeenCalledTimes(1);
    const updateCall = (mockDb.episode.update.mock.calls as any)[0][0] as any;
    // Should be truncated to ~1500 chars + prefix
    expect(updateCall.data.summary.length).toBeLessThan(longSummary.length + 50);
  });
});

describe('memory/summarization: getEpisodeSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEpisodes.clear();
  });

  it('returns null when episode not found', async () => {
    const { getEpisodeSummary } = await import('@/lib/memory/summarization');
    const result = await getEpisodeSummary('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when episode has no summary', async () => {
    mockEpisodes.set('ep1', { summary: null, _count: { messages: 0 } });
    const { getEpisodeSummary } = await import('@/lib/memory/summarization');
    const result = await getEpisodeSummary('ep1');
    expect(result).toBeNull();
  });

  it('strips [summarized@N] prefix from summary', async () => {
    mockEpisodes.set('ep1', {
      summary: '[summarized@20] Real summary content here',
      _count: { messages: 20 },
    });
    const { getEpisodeSummary } = await import('@/lib/memory/summarization');
    const result = await getEpisodeSummary('ep1');
    expect(result).toBe('Real summary content here');
  });

  it('returns summary as-is when prefix is missing (legacy)', async () => {
    mockEpisodes.set('ep1', {
      summary: 'Legacy summary without prefix',
      _count: { messages: 20 },
    });
    const { getEpisodeSummary } = await import('@/lib/memory/summarization');
    const result = await getEpisodeSummary('ep1');
    expect(result).toBe('Legacy summary without prefix');
  });
});
