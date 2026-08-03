import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import {
  createTestEpisode,
  deleteTestEpisode,
  readResponseBody,
  getLatestCompanionMessage,
} from './helpers';
import { db } from '@/lib/db';

// ============================================================================
// Phase 7 — Persist turn + monologue routing contracts.
// ============================================================================
//
// Purpose: turn persistence (user + companion messages) and inner monologue
// routing are part of the pipeline contract, not peripheral.
// These tests verify:
//   1. persistChatTurn saves user + companion messages to DB
//   2. Inner monologue routing: trivial/standard-task skips decideHowToRespond;
//      standard+emotional and plus run it
//
// DoD: persist path covered; inner monologue routing verified.

// ── Hoisted mocks (vitest hoisting-safe) ──

const { streamTextMock, capturedStreamParams, attachOnFinish, onFinishRef } = vi.hoisted(() => {
  const capturedStreamParams: { current: Record<string, unknown> | null } = { current: null };
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

  return { streamTextMock, capturedStreamParams, attachOnFinish, onFinishRef };
});

const generateTextMock = vi.fn(async () => ({
  text: 'mock analysis',
  usage: { promptTokens: 5, completionTokens: 10 },
}));

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

const getCognitiveParamsMock = vi.fn(async () => ({
  params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
  profile: {
    tier: 'standard', modelSize: 7, gpuName: 'mock',
    vramGb: 16, isCpuOnly: false, contextWindow: 8192,
  },
}));

vi.mock('@/lib/capability-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capability-profile')>();
  return {
    ...actual,
    getCognitiveParams: getCognitiveParamsMock,
    getCapabilityProfile: vi.fn(async () => ({
      tier: 'standard', modelSize: 7, gpuName: 'mock',
      vramGb: 16, isCpuOnly: false, contextWindow: 8192,
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
    usedSecondary: false, modelName: 'qwen2.5:7b', reason: 'primary',
  })),
}));

vi.mock('@/lib/chat/deliberate', () => ({
  runDeliberate: vi.fn(async () => 'MOCK_ANALYSIS'),
}));
vi.mock('@/lib/chat/self-check', () => ({
  runSelfCheck: vi.fn(async () => ({ issues: [], severity: 'ok' })),
}));

// ── Tests ──

describe('Phase 7 — persistChatTurn + dedup contracts', () => {
  let episodeId: string;

  beforeEach(async () => {
    // Дождаться async onFinish предыдущего теста.
    await onFinishRef.current;
    onFinishRef.current = Promise.resolve();
    vi.clearAllMocks();
    capturedStreamParams.current = null;
    getCognitiveParamsMock.mockResolvedValue({
      params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
      profile: {
        tier: 'standard', modelSize: 7, gpuName: 'mock',
        vramGb: 16, isCpuOnly: false, contextWindow: 8192,
      },
    });
    episodeId = await createTestEpisode();
  });

  afterEach(async () => {
    await deleteTestEpisode(episodeId);
  });

  // ── Scenario 1: persistChatTurn saves user + companion messages to DB ──
  it('persists both user and companion messages to the DB after stream finishes', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Привет, расскажи про React', episodeId, mode: 'auto' });

    // Wait for onFinish → persistChatTurn.
    await onFinishRef.current;

    // User message saved.
    const userMsg = await db.message.findFirst({
      where: { episodeId, role: 'user' },
      orderBy: { createdAt: 'desc' },
    });
    expect(userMsg).not.toBeNull();
    expect(userMsg?.content).toBe('Привет, расскажи про React');

    // Companion message saved.
    const companion = await getLatestCompanionMessage(episodeId);
    expect(companion).toContain('Ответ тестовой Лии');

    // streamText called exactly once (no duplicate calls).
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 2: trivial on standard → monologue skipped ──
  it('standard tier + trivial greeting → inner monologue skipped', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Привет, как дела?', episodeId, mode: 'auto' });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const generateCalls = generateTextMock.mock.calls;
    const innerMonologueCall = generateCalls.find((c: unknown[]) => {
      const params = c[0] as { system?: string; prompt?: string };
      const text = `${params.system ?? ''} ${params.prompt ?? ''}`;
      return text.includes('внутреннее размышление') || text.includes('Реши: как ты хочешь ответить');
    });
    expect(innerMonologueCall).toBeUndefined();
  });

  // ── Scenario 2a: standard + emotional → monologue still skipped (latency pass) ──
  it('standard tier + emotional message → inner monologue skipped', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        action: 'emotional_response',
        desiredTone: 'warm',
        willingnessToHelp: 0.8,
        emotionalExpression: 'concern',
        motivation: 'Ей тяжело — хочу поддержать',
        confidence: 0.7,
      }),
      usage: { promptTokens: 5, completionTokens: 10 },
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'Мне очень грустно и одиноко, просто поговори со мной',
      episodeId,
      mode: 'auto',
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const generateCalls = generateTextMock.mock.calls;
    const innerMonologueCall = generateCalls.find((c: unknown[]) => {
      const params = c[0] as { system?: string; prompt?: string };
      const text = `${params.system ?? ''} ${params.prompt ?? ''}`;
      return text.includes('внутреннее размышление') || text.includes('Реши: как ты хочешь ответить');
    });
    // Latency pass: monologue LLM always off — fallback decision only.
    expect(innerMonologueCall).toBeUndefined();
  });

  // ── Scenario 2b: plus tier → inner monologue still skipped (latency pass) ──
  it('plus tier + moderate complexity → inner monologue skipped', async () => {
    getCognitiveParamsMock.mockResolvedValue({
      params: { agentMaxSteps: 100, agentMaxDurationSec: 21600, tier: 'plus' },
      profile: {
        tier: 'plus', modelSize: 32, gpuName: 'mock-4090',
        vramGb: 48, isCpuOnly: false, contextWindow: 32768,
      },
    });

    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        action: 'help',
        desiredTone: 'curious',
        willingnessToHelp: 0.8,
        emotionalExpression: 'curiosity',
        motivation: 'Интересный вопрос',
        confidence: 0.7,
      }),
      usage: { promptTokens: 5, completionTokens: 10 },
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({ text: 'Сложный вопрос требующий анализа', episodeId, mode: 'auto' });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 3: pipeline returns 404 for non-existent episode ──
  it('non-existent episode → 404, no messages persisted', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({
      text: 'Привет',
      episodeId: '00000000-0000-0000-0000-000000000000',
      mode: 'auto',
    });

    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(404);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
