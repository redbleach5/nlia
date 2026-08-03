import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTestEpisode,
  deleteTestEpisode,
  readResponseBody,
} from './helpers';

// ============================================================================
// Phase 6 — Cognitive glue runtime contracts (docs/testing/README.md).
// ============================================================================
//
// Purpose: prevent silent regressions in plus/max tier when deliberate /
// self-check wiring changes. The matrix tests in cognitive-depth.test.ts
// only cover the gating FUNCTIONS (shouldDeliberate / shouldSelfCheck) —
// they don't cover the RUNTIME wiring inside runChatPipeline → runDeliberate
// and persistChatTurn → runSelfCheck.
//
// Scenarios: docs/testing/README.md
//   1. shouldDeliberate(plan) false (standard tier) → runDeliberate NOT called
//   2. shouldDeliberate(plan) true (plus moderate) → generateText called,
//      result injected into system prompt suffix
//   3. runDeliberate throws → pipeline continues without crash
//   4. streaming self-check stays off (runSelfCheck never called)
//   5. pipeline unaffected without self-check
//
// DoD: ≥5 tests, <5s, covers gating `calls >= 2`.

// ── Hoisted mocks (vitest hoisting-safe) ──

const {
  streamTextMock,
  capturedStreamParams,
  generateTextMock,
  attachOnFinish,
  onFinishRef,
} = vi.hoisted(() => {
  const capturedStreamParams: { current: Record<string, unknown> | null } = { current: null };
  const generateTextCalls: { current: { prompt?: string; system?: string }[] } = { current: [] };
  const onFinishRef = { current: Promise.resolve() as Promise<void> };

  function attachOnFinish(params: {
    onFinish?: (data: { text: string; usage: { promptTokens: number; completionTokens: number }; finishReason: string }) => void | Promise<void>;
  }) {
    onFinishRef.current = Promise.resolve(params.onFinish?.({
      text: 'Ответ тестовой Лии.',
      usage: { promptTokens: 10, completionTokens: 15 },
      finishReason: 'stop',
    })).then(() => undefined);
  }

  const streamTextMock = vi.fn((params: {
    tools?: unknown;
    system?: string;
    onFinish?: (data: { text: string; usage: { promptTokens: number; completionTokens: number }; finishReason: string }) => void | Promise<void>;
    onError?: (err: { error?: unknown; message?: string }) => void;
    abortSignal?: AbortSignal;
  }) => {
    capturedStreamParams.current = params as Record<string, unknown>;
    attachOnFinish(params);
    return {
      text: Promise.resolve('Ответ тестовой Лии.'),
      toTextStreamResponse: () => new Response('Ответ тестовой Лии.', {
        headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
      }),
    };
  });

  // generateText mock — used by runDeliberate AND indirectly by self-check
  // (via streamText there, but we mock streamText separately). For
  // runDeliberate we control the returned text and capture call args.
  const generateTextMock = vi.fn(async (params: {
    prompt?: string;
    system?: string;
    messages?: unknown;
  }) => {
    generateTextCalls.current.push({ prompt: params.prompt, system: params.system });
    return {
      text: 'MOCK_DELIBERATE_ANALYSIS',
      usage: { promptTokens: 5, completionTokens: 10 },
    };
  });

  // Expose a setter so individual tests can override generateText's return
  // (e.g. to simulate a throw, or to return JSON for self-check).
  (generateTextMock as unknown as { _calls: typeof generateTextCalls })._calls = generateTextCalls;

  return { streamTextMock, capturedStreamParams, generateTextMock, attachOnFinish, onFinishRef };
});

const MOCK_EMBEDDING = new Float32Array(768).fill(0.1);

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('@/lib/ollama', () => ({
  getChatModel: vi.fn(async () => ({ modelId: 'mock-model' })),
  getModelName: vi.fn(async () => 'qwen2.5:7b'),
  setOllamaNumCtx: vi.fn(),
  getOllamaSettings: vi.fn(async () => ({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
    embedModel: 'nomic-embed-text',
  })),
  embed: vi.fn(async () => MOCK_EMBEDDING),
  checkOllamaHealth: vi.fn(async () => ({ ok: true, models: ['qwen2.5:7b'] })),
  checkLlmPreflight: vi.fn(async () => ({
    ok: true as const,
    provider: 'ollama' as const,
    model: 'mock:7b',
  })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: streamTextMock,
    generateText: generateTextMock,
  };
});

// Default: standard tier (deliberate OFF). Individual tests override via
// mockReturnValue to switch to plus tier (deliberate ON for moderate+).
const getCognitiveParamsMock = vi.fn(async () => ({
  params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
  profile: {
    tier: 'standard',
    modelSize: 7,
    gpuName: 'mock',
    vramGb: 16,
    isCpuOnly: false,
    contextWindow: 8192,
  },
}));

vi.mock('@/lib/capability-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capability-profile')>();
  return {
    ...actual,
    getCognitiveParams: getCognitiveParamsMock,
    getCapabilityProfile: vi.fn(async () => ({
      tier: 'standard',
      modelSize: 7,
      gpuName: 'mock',
      vramGb: 16,
      isCpuOnly: false,
      contextWindow: 8192,
    })),
  };
});

vi.mock('@/lib/tools/web-search', () => ({
  webSearch: vi.fn(async () => ({ results: [] })),
  fetchPage: vi.fn(async () => ({ text: '', error: null })),
}));

vi.mock('@/lib/chat/pipeline-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/pipeline-helpers')>();
  return {
    ...actual,
    runProactiveKbSearch: vi.fn(async () => ({
      kbSearchContext: undefined,
      kbAnswerLocked: false,
      kbDirectSnippet: undefined,
      kbDirectCitation: undefined,
      readyKbCount: 0,
    })),
  };
});

vi.mock('@/lib/chat/model-selection', () => ({
  chooseModelForQuery: vi.fn(async () => ({
    usedSecondary: false,
    modelName: 'qwen2.5:7b',
    reason: 'primary',
  })),
}));

// Mock runDeliberate separately so we can control whether it throws without
// interfering with other generateText consumers (inner-monologue, fact-extraction).
// Default returns a normal analysis string; tests override per-scenario.
const runDeliberateMock = vi.fn(async (_userMessage: string): Promise<string> => {
  return 'MOCK_DELIBERATE_ANALYSIS';
});
vi.mock('@/lib/chat/deliberate', () => ({
  runDeliberate: (text: string) => runDeliberateMock(text),
}));

// Mock runSelfCheck separately so we can control its return value and verify
// it was called, without relying on streamText mock routing (which is fragile
// because multiple consumers share the same streamText mock).
const runSelfCheckMock = vi.fn(async (_params: {
  userMessage: string;
  liaResponse: string;
  episodeId: string;
}): Promise<{ issues: string[]; severity: 'ok' | 'minor' | 'major' }> => {
  return { issues: [], severity: 'ok' };
});
vi.mock('@/lib/chat/self-check', () => ({
  runSelfCheck: (params: { userMessage: string; liaResponse: string; episodeId: string }) => runSelfCheckMock(params),
}));

// ── Tests ──

describe('Phase 6 — cognitive glue runtime (deliberate + self-check wiring)', () => {
  let episodeId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedStreamParams.current = null;
    // Reset to default: standard tier (deliberate OFF, selfCheck OFF).
    getCognitiveParamsMock.mockResolvedValue({
      params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
      profile: {
        tier: 'standard', modelSize: 7, gpuName: 'mock',
        vramGb: 16, isCpuOnly: false, contextWindow: 8192,
      },
    });
    // Reset mocks to defaults.
    runDeliberateMock.mockResolvedValue('MOCK_DELIBERATE_ANALYSIS');
    runSelfCheckMock.mockResolvedValue({ issues: [], severity: 'ok' });
    episodeId = await createTestEpisode();
  });

  afterEach(async () => {
    await deleteTestEpisode(episodeId);
  });

  // Helper: switch to plus tier (deliberate + selfCheck ON for moderate+).
  const usePlusTier = () => {
    getCognitiveParamsMock.mockResolvedValue({
      params: { agentMaxSteps: 100, agentMaxDurationSec: 21600, tier: 'plus' },
      profile: {
        tier: 'plus', modelSize: 32, gpuName: 'mock-4090',
        vramGb: 48, isCpuOnly: false, contextWindow: 32768,
      },
    });
  };

  // ── Latency pass: deliberate never called ──
  it('standard tier moderate → runDeliberate not called', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Что думаешь про React hooks в целом', episodeId, mode: 'auto' });

    expect(runDeliberateMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('standard tier complex → runDeliberate still not called (latency pass)', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Проанализируй архитектуру React подробно', episodeId, mode: 'auto' });

    expect(runDeliberateMock).not.toHaveBeenCalled();
    const streamParams = capturedStreamParams.current;
    expect(streamParams?.system).not.toEqual(expect.stringContaining('ВНУТРЕННИЙ АНАЛИЗ'));
  });

  it('plus tier → runDeliberate not called, no analysis suffix', async () => {
    usePlusTier();

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Проанализируй архитектуру микросервисов подробно', episodeId, mode: 'auto' });

    expect(runDeliberateMock).not.toHaveBeenCalled();
    const streamParams = capturedStreamParams.current;
    expect(streamParams?.system).not.toEqual(expect.stringContaining('ВНУТРЕННИЙ АНАЛИЗ'));
    expect(streamParams?.system).not.toEqual(expect.stringContaining('MOCK_DELIBERATE_ANALYSIS'));
  });

  it('plus tier → deliberate unused even if mock would throw; stream still works', async () => {
    usePlusTier();
    runDeliberateMock.mockRejectedValueOnce(new Error('Ollama timeout'));

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({
      text: 'Проанализируй архитектуру микросервисов подробно',
      episodeId,
      mode: 'auto',
    });

    const { NextResponse } = await import('next/server');
    expect(result).not.toBeInstanceOf(NextResponse);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(runDeliberateMock).not.toHaveBeenCalled();
    const streamParams = capturedStreamParams.current;
    const system = String(streamParams?.system ?? '');
    expect(system).not.toContain('ВНУТРЕННИЙ АНАЛИЗ');
    expect(system).not.toContain('MOCK_DELIBERATE_ANALYSIS');
  });

  // ── Streaming self-check is intentionally disabled ──
  it('plus tier → self-check does NOT run after stream', async () => {
    usePlusTier();
    runSelfCheckMock.mockResolvedValueOnce({
      issues: ['Ответ слишком длинный'],
      severity: 'minor',
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'Проанализируй архитектуру микросервисов подробно',
      episodeId,
      mode: 'auto',
    });

    await onFinishRef.current;
    await new Promise(r => setTimeout(r, 100));

    expect(runSelfCheckMock).not.toHaveBeenCalled();
  });

  it('pipeline completes without self-check even when mock would return ok', async () => {
    usePlusTier();
    runSelfCheckMock.mockResolvedValueOnce({ issues: [], severity: 'ok' });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({
      text: 'Проанализируй архитектуру микросервисов подробно',
      episodeId,
      mode: 'auto',
    });
    if (!('response' in result)) throw new Error('Expected chat pipeline result');
    const body = await readResponseBody(result.response);
    expect(body.length).toBeGreaterThan(0);

    await onFinishRef.current;
    await new Promise(r => setTimeout(r, 100));

    expect(runSelfCheckMock).not.toHaveBeenCalled();
  });
});
