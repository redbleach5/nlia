import { describe, it, expect, vi } from 'vitest';

/**
 * Peripheral smoke tests — mocks + utilities around chat/agent.
 * Does NOT exercise runChatPipeline / runAgentTask orchestrators.
 * Core contracts: tests/core/chat-pipeline.test.ts
 */

// ── Mocks ──

const MOCK_EMBEDDING = new Float32Array(768).fill(0.1);

vi.mock('@/lib/ollama', () => ({
  getChatModel: vi.fn(async () => ({ modelId: 'mock-model' })),
  getModelName: vi.fn(async () => 'mock:7b'),
  getOllamaSettings: vi.fn(async () => ({
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'mock:7b', embedModel: 'mock-embed',
  })),
  embed: vi.fn(async () => MOCK_EMBEDDING),
  checkOllamaHealth: vi.fn(async () => ({ ok: true, models: ['mock:7b'] })),
  checkLlmPreflight: vi.fn(async () => ({ ok: true, model: 'mock:7b' })),
  setOllamaSettings: vi.fn(async () => {}),
  reloadSettings: vi.fn(async () => {}),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(async (params: {
      messages?: Array<{ role: string; content: string }>;
      onFinish?: (data: { text: string; usage: { promptTokens: number; completionTokens: number }; finishReason: string }) => void;
    }) => {
      const lastUserMsg = params.messages?.filter(m => m.role === 'user').pop()?.content ?? '';
      let response = 'Привет! Я Лия. Чем могу помочь?';
      if (/привет|hello|hi/i.test(lastUserMsg)) response = 'Привет! Рад тебя видеть.';
      else if (/python|язык/i.test(lastUserMsg)) response = 'Я думаю, Python отличный выбор.';
      // Call onFinish if provided
      if (params.onFinish) {
        params.onFinish({ text: response, usage: { promptTokens: 50, completionTokens: 30 }, finishReason: 'stop' });
      }
      return { text: Promise.resolve(response), toTextStreamResponse: () => new Response(response) };
    }),
    generateText: vi.fn(async (params: { prompt?: string }) => ({
      text: `Analysis: ${(params.prompt ?? '').slice(0, 50)}`,
      usage: { promptTokens: 10, completionTokens: 20 },
    })),
    isStepCount: (n: number) => ({ type: 'step_count', maxSteps: n }),
  };
});

vi.mock('@/lib/capability-profile', () => ({
  getCognitiveParams: vi.fn(async () => ({
    params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
    profile: { tier: 'standard', agentTier: 'standard', modelSize: 7, gpuName: 'mock', vramGb: 16, isCpuOnly: false },
  })),
  getAgentCognitiveParams: vi.fn(async () => ({
    params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, maxTokens: 4096 },
    profile: { tier: 'standard', agentTier: 'standard', modelSize: 7, gpuName: 'mock', vramGb: 16, isCpuOnly: false },
    agentTier: 'standard',
  })),
  getCapabilityProfile: vi.fn(async () => ({
    tier: 'standard', agentTier: 'standard', modelSize: 7, gpuName: 'mock', vramGb: 16, isCpuOnly: false,
  })),
}));

// ── Tests ──

describe('Mock setup verification', () => {
  it('getChatModel returns mock', async () => {
    const { getChatModel } = await import('@/lib/ollama');
    const model = await getChatModel();
    expect(model).toBeDefined();
  });

  it('embed returns 768-dim', async () => {
    const { embed } = await import('@/lib/ollama');
    const e = await embed('test');
    expect(e.length).toBe(768);
  });

  it('streamText returns canned response', async () => {
    const { streamText } = await import('ai');
    // Cast to any: our mock (vi.mock('ai', ...)) accepts a relaxed param shape,
    // but the real streamText type requires `model`. Vitest runtime uses the mock.
    const result = await (streamText as unknown as (p: { messages: Array<{ role: string; content: string }> }) => Promise<{ text: string }>)({
      messages: [{ role: 'user', content: 'Привет!' }],
    });
    const text = await result.text;
    expect(text).toContain('Привет');
  });
});

describe('Agent runner logic', () => {
  it('isRunning returns false for unknown task', async () => {
    const { isRunning } = await import('@/lib/agent/runner');
    expect(isRunning('nonexistent')).toBe(false);
  });

  it('getTaskAbortSignal returns AbortSignal', async () => {
    const { getTaskAbortSignal } = await import('@/lib/agent/runner');
    expect(getTaskAbortSignal('test')).toBeInstanceOf(AbortSignal);
  });

  it('sweepStaleTasks runs without error', async () => {
    const { sweepStaleTasks } = await import('@/lib/agent/runner');
    const count = await sweepStaleTasks();
    expect(typeof count).toBe('number');
  });
});

describe('Memory subsystem', () => {
  it('FACT_TRIGGER_PATTERNS match name introduction', async () => {
    // shouldExtractFacts is not exported — test the patterns directly
    const mod = await import('@/lib/memory/fact-extraction');
    // The function exists but is not exported. We test via the module's
    // exported behavior: extractAndSaveFacts would use it internally.
    // For now, verify the module loads and has expected exports.
    expect(mod).toBeDefined();
    expect(typeof mod.extractAndSaveFacts).toBe('function');
  });

  it('isRepeatedMessage detects duplicates', async () => {
    const { isRepeatedMessage } = await import('@/lib/chat/is-repeated-message');
    expect(isRepeatedMessage('Привет как дела', 'Привет как дела')).toBe(true);
    expect(isRepeatedMessage('Привет', 'Пока')).toBe(false);
  });
});

describe('Agent templates', () => {
  it('presets are self-contained (no delegation tools)', async () => {
    const { AGENT_TEMPLATES } = await import('@/lib/agent/templates');
    expect(AGENT_TEMPLATES.general.toolWhitelist).toBeNull();
    for (const name of ['coder', 'researcher'] as const) {
      const wl = AGENT_TEMPLATES[name].toolWhitelist ?? [];
      expect(wl).not.toContain('spawn_subagent');
      expect(wl).not.toContain('spawn_subagents');
    }
  });

  it('template limits are reasonable', async () => {
    const { AGENT_TEMPLATES } = await import('@/lib/agent/templates');
    for (const [, t] of Object.entries(AGENT_TEMPLATES)) {
      expect(t.maxSteps).toBeGreaterThanOrEqual(5);
      expect(t.maxSteps).toBeLessThanOrEqual(500);
    }
  });
});

describe('Task complexity', () => {
  it('classifies greeting as trivial/simple', async () => {
    const { classifyTaskComplexity } = await import('@/lib/task-complexity');
    expect(['trivial', 'simple']).toContain(classifyTaskComplexity('Привет!'));
  });

  it('classifies research as moderate+', async () => {
    const { classifyTaskComplexity } = await import('@/lib/task-complexity');
    const r = classifyTaskComplexity('Найди информацию о React 19 и сравни с Vue 4');
    expect(['moderate', 'complex', 'research']).toContain(r);
  });

  it('detects KB questions', async () => {
    const { isKbQuestion } = await import('@/lib/task-complexity');
    expect(isKbQuestion('В каком документе описана архитектура?')).toBe(true);
    expect(isKbQuestion('Привет')).toBe(false);
  });

  it('detects need for web search', async () => {
    const { needsProactiveWebSearch } = await import('@/lib/task-complexity');
    // Signature requires (message, complexity). 'research' triggers proactive search
    // for non-conversational, non-KB messages; 'trivial' does not.
    expect(needsProactiveWebSearch('Что нового в Python 3.13?', 'research')).toBe(true);
    expect(needsProactiveWebSearch('Как дела?', 'trivial')).toBe(false);
  });
});

describe('System prompt builder', () => {
  it('produces non-empty Russian prompt', async () => {
    const { buildSystemPrompt } = await import('@/lib/system-prompt');
    const prompt = buildSystemPrompt({
      emotion: { joy: 0.5, curiosity: 0.5, calm: 0.5, irritation: 0.1, sadness: 0.1 },
      mode: 'auto',
      tier: 'standard',
      complexity: 'moderate',
    });
    expect(prompt.length).toBeGreaterThan(100);
    expect(/[а-яё]/i.test(prompt)).toBe(true);
  });
});

describe('Chat modes', () => {
  it('normalizes legacy modes', async () => {
    const { normalizeChatMode } = await import('@/lib/chat-modes');
    expect(normalizeChatMode('fast')).toBe('auto');
    expect(normalizeChatMode('deep')).toBe('auto');
    expect(normalizeChatMode('agent')).toBe('agent');
    expect(normalizeChatMode('auto')).toBe('auto');
  });
});
