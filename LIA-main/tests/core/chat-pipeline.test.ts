import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import {
  createTestEpisode,
  deleteTestEpisode,
  readResponseBody,
  getLatestCompanionMessage,
} from './helpers';

// ── Hoisted mocks (vitest hoisting-safe) ──

const { streamTextMock, capturedStreamParams, kbSearchMock, onFinishRef, attachOnFinish } = vi.hoisted(() => {
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

  const kbSearchMock = vi.fn(async (..._args: unknown[]) => ({
    kbSearchContext: undefined as string | undefined,
    kbAnswerLocked: false,
    kbDirectSnippet: undefined as string | undefined,
    kbDirectCitation: undefined as string | undefined,
    readyKbCount: 0,
  }));

  return { streamTextMock, capturedStreamParams, kbSearchMock, onFinishRef, attachOnFinish };
});

const MOCK_EMBEDDING = new Float32Array(768).fill(0.1);

type PreflightResult =
  | { ok: true; provider: 'ollama'; model: string }
  | {
    ok: false;
    failure: {
      code: string;
      message: string;
      details: string;
      ollamaUrl: string;
    };
  };

const checkLlmPreflightMock = vi.fn(async (): Promise<PreflightResult> => ({
  ok: true as const,
  provider: 'ollama' as const,
  model: 'mock:7b',
}));

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
  checkLlmPreflight: checkLlmPreflightMock,
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: streamTextMock,
    generateText: vi.fn(async () => ({
      text: 'mock analysis',
      usage: { promptTokens: 5, completionTokens: 10 },
    })),
  };
});

vi.mock('@/lib/capability-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capability-profile')>();
  return {
    ...actual,
    getCognitiveParams: vi.fn(async () => ({
      params: { agentMaxSteps: 25, agentMaxDurationSec: 3600, tier: 'standard' },
      profile: {
        tier: 'standard',
        modelSize: 7,
        gpuName: 'mock',
        vramGb: 16,
        isCpuOnly: false,
        contextWindow: 8192,
      },
    })),
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
  webSearch: vi.fn(async () => ({
    results: [{
      title: 'Python 3.13',
      url: 'https://example.com/python-3-13',
      snippet: 'Release highlights',
    }],
  })),
  fetchPage: vi.fn(async () => ({
    text: 'Python 3.13 introduces improved typing and performance improvements.',
    error: null,
  })),
}));

vi.mock('@/lib/chat/pipeline-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/pipeline-helpers')>();
  return {
    ...actual,
    runProactiveKbSearch: (...args: unknown[]) => kbSearchMock(...args),
  };
});

vi.mock('@/lib/chat/model-selection', () => ({
  chooseModelForQuery: vi.fn(async () => ({
    usedSecondary: false,
    modelName: 'qwen2.5:7b',
    reason: 'primary',
  })),
}));

// ── Tests ──

describe('runChatPipeline (core contracts)', () => {
  let episodeId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedStreamParams.current = null;
    kbSearchMock.mockResolvedValue({
      kbSearchContext: undefined,
      kbAnswerLocked: false,
      kbDirectSnippet: undefined,
      kbDirectCitation: undefined,
      readyKbCount: 0,
    });
    checkLlmPreflightMock.mockResolvedValue({
      ok: true,
      provider: 'ollama',
      model: 'mock:7b',
    });
    streamTextMock.mockImplementation((params: {
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
    episodeId = await createTestEpisode();
  });

  afterEach(async () => {
    await deleteTestEpisode(episodeId);
  });

  it('happy path: persists user + companion messages and returns non-empty stream', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({
      text: 'Привет!',
      episodeId,
      mode: 'auto',
    });

    expect(result).not.toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) return;

    const body = await readResponseBody(result.response);
    expect(body.length).toBeGreaterThan(0);

    await onFinishRef.current;
    const companion = await getLatestCompanionMessage(episodeId);
    expect(companion).toContain('Ответ тестовой Лии');
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when episode does not exist', async () => {
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

  it('returns 503 when LLM pre-flight fails', async () => {
    checkLlmPreflightMock.mockResolvedValueOnce({
      ok: false,
      failure: {
        code: 'ollama_down',
        message: 'Ollama недоступен',
        details: 'ECONNREFUSED',
        ollamaUrl: 'http://127.0.0.1:11434',
      },
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({ text: 'Привет', episodeId, mode: 'auto' });

    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/Ollama/i);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('disables tools when proactive web search injected context (regression)', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'Что нового в Python 3.13?',
      episodeId,
      mode: 'auto',
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const params = capturedStreamParams.current;
    expect(params?.tools).toBeUndefined();
    expect(params?.system).toEqual(expect.stringContaining('АКТУАЛЬНЫЕ РЕЗУЛЬТАТЫ ПОИСКА'));
  });

  it('disables tools when KB answer is locked', async () => {
    kbSearchMock.mockResolvedValueOnce({
      kbSearchContext: 'Фрагмент из базы знаний',
      kbAnswerLocked: true,
      kbDirectSnippet: 'Auth uses JWT tokens.',
      kbDirectCitation: '[Architecture > auth]',
      readyKbCount: 2,
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'В каком документе описана аутентификация?',
      episodeId,
      mode: 'auto',
    });

    const params = capturedStreamParams.current;
    expect(params?.tools).toBeUndefined();
  });

  it('returns fallback text when streamText reports error via onError', async () => {
    streamTextMock.mockImplementationOnce((params) => {
      capturedStreamParams.current = params as Record<string, unknown>;
      params.onError?.({ error: new Error('429'), message: '429 Too Many Requests' });
      return {
        text: Promise.resolve(''),
        toTextStreamResponse: () => new Response('', { headers: new Headers() }),
      };
    });

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    const result = await runChatPipeline({ text: 'Расскажи про React', episodeId, mode: 'auto' });

    expect(result).not.toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) return;

    const body = await readResponseBody(result.response);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/429|запрос|⚠️/i);
  });

  it('passes client abortSignal to streamText', async () => {
    const abortSignal = AbortSignal.abort();

    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'Привет',
      episodeId,
      mode: 'auto',
      abortSignal,
    });

    const params = capturedStreamParams.current;
    expect(params?.abortSignal).toBeDefined();
    // Pipeline combines client signal with timeout via AbortSignal.any()
    expect((params?.abortSignal as AbortSignal).aborted).toBe(true);
  });

  it('enables tools for moderate+ questions without proactive RAG', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    // "проанализируй" → complex → toolsEnabled on plan
    await runChatPipeline({
      text: 'Проанализируй плюсы и минусы let и const в JavaScript подробно',
      episodeId,
      mode: 'auto',
    });

    const params = capturedStreamParams.current;
    expect(params?.tools).toBeDefined();
  });

  it('disables tools on simple social/acquaintance (latency pass)', async () => {
    const { runChatPipeline } = await import('@/lib/chat/pipeline');
    await runChatPipeline({
      text: 'Привет. Кто ты?',
      episodeId,
      mode: 'auto',
    });

    const params = capturedStreamParams.current;
    expect(params?.tools).toBeUndefined();
  });
});
