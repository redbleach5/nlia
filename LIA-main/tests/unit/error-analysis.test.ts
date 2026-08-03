import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests for src/lib/agent/error-analysis.ts
 *
 * Tests the smart error analysis feature:
 *   - parseTaskError: parses legacy string vs JSON {message, analysis?}
 *   - serializeTaskError: round-trip serialization
 *   - analyzeTaskFailure: LLM call with mocked responses
 *   - analyzeAndStoreFailure: full flow with mocked DB
 *
 * Mocks:
 *   - @/lib/ollama.getChatModel — returns mock model
 *   - ai.generateText — returns canned JSON diagnosis
 *   - @/lib/db — in-memory agentTask table
 */

vi.mock('@/lib/ollama', () => ({
  getChatModel: vi.fn(async () => ({ modelId: 'mock-model' })),
  // error-analysis uses getAgentModel (plan/execute path), not getChatModel
  getAgentModel: vi.fn(async () => ({ modelId: 'mock-agent-model' })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

// Mock 'ai' module — generateText is the only function used by error-analysis.
// We use vi.hoisted so the mock factory can reference the mock fn before module eval.
const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

// In-memory DB mock for analyzeAndStoreFailure
const mockDb = {
  agentTask: {
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
  },
};
vi.mock('@/lib/db', () => ({ db: mockDb }));

describe('error-analysis: parseTaskError', () => {
  it('returns null for null/undefined input', async () => {
    const { parseTaskError } = await import('@/lib/agent/error-analysis');
    expect(parseTaskError(null)).toBeNull();
    expect(parseTaskError(undefined)).toBeNull();
    expect(parseTaskError('')).toBeNull();
  });

  it('parses plain string as { message } without analysis', async () => {
    const { parseTaskError } = await import('@/lib/agent/error-analysis');
    const result = parseTaskError('LLM не отвечает');
    expect(result).toEqual({ message: 'LLM не отвечает' });
    expect(result?.analysis).toBeUndefined();
  });

  it('parses JSON { message, analysis } format', async () => {
    const { parseTaskError } = await import('@/lib/agent/error-analysis');
    const json = JSON.stringify({
      message: 'Pre-flight failed',
      analysis: {
        rootCause: 'Ollama not running',
        explanation: 'Сервер Ollama не запущен',
        suggestedFix: 'Запустите ollama serve',
        confidence: 'high',
      },
    });
    const result = parseTaskError(json);
    expect(result?.message).toBe('Pre-flight failed');
    expect(result?.analysis?.rootCause).toBe('Ollama not running');
    expect(result?.analysis?.confidence).toBe('high');
  });

  it('falls back to plain string for invalid JSON', async () => {
    const { parseTaskError } = await import('@/lib/agent/error-analysis');
    // Starts with { but not valid JSON
    const result = parseTaskError('{invalid json content');
    expect(result?.message).toBe('{invalid json content');
    expect(result?.analysis).toBeUndefined();
  });

  it('falls back to plain string for JSON without message field', async () => {
    const { parseTaskError } = await import('@/lib/agent/error-analysis');
    const result = parseTaskError('{"foo": "bar"}');
    expect(result?.message).toBe('{"foo": "bar"}');
  });
});

describe('error-analysis: serializeTaskError', () => {
  it('serializes plain message as string', async () => {
    const { serializeTaskError } = await import('@/lib/agent/error-analysis');
    const result = serializeTaskError({ message: 'Simple error' });
    expect(result).toBe('Simple error');
  });

  it('serializes message + analysis as JSON', async () => {
    const { serializeTaskError, parseTaskError } = await import('@/lib/agent/error-analysis');
    const err = {
      message: 'Task failed',
      analysis: {
        rootCause: 'Loop detected',
        explanation: 'Агент зациклился',
        suggestedFix: 'Уточните задачу',
        confidence: 'medium' as const,
      },
    };
    const serialized = serializeTaskError(err);
    const parsed = parseTaskError(serialized);
    expect(parsed).toEqual(err);
  });
});

describe('error-analysis: analyzeTaskFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for trivially short errors', async () => {
    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test task',
      errorMessage: 'cancelled',
      steps: [],
    });
    expect(result).toBeNull();
  });

  it('returns null for "aborted" error', async () => {
    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test task',
      errorMessage: 'aborted',
      steps: [],
    });
    expect(result).toBeNull();
  });

  it('parses LLM JSON response into ErrorAnalysis', async () => {
    // Mock generateText to return valid JSON diagnosis
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rootCause: 'API key invalid',
        explanation: 'Невалидный Ollama API key',
        suggestedFix: 'Проверьте OLLAMA_BASE_URL в Settings',
        confidence: 'high',
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Build a React app',
      errorMessage: 'Pre-flight failed: ollama_no_models',
      steps: [
        { thought: 'Starting task', action: 'plan', input: {}, observation: 'ok' },
        { thought: 'Calling LLM', action: 'reason', input: {}, observation: 'Ошибка: timeout' },
      ],
      modelName: 'qwen2.5:7b',
    });

    expect(result).not.toBeNull();
    expect(result?.rootCause).toBe('API key invalid');
    expect(result?.explanation).toBe('Невалидный Ollama API key');
    expect(result?.suggestedFix).toContain('OLLAMA_BASE_URL');
    expect(result?.confidence).toBe('high');
  });

  it('extracts JSON from markdown-wrapped LLM response', async () => {
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: '```json\n{"rootCause":"Loop","explanation":"Цикл","suggestedFix":"Уточни","confidence":"medium"}\n```',
      usage: { promptTokens: 100, completionTokens: 50 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'Circuit breaker: 3 consecutive stream errors',
      steps: [],
    });

    expect(result?.rootCause).toBe('Loop');
    expect(result?.confidence).toBe('medium');
  });

  it('uses the first balanced JSON object instead of a greedy match', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{"rootCause":"Timeout","explanation":"Истёк таймаут","suggestedFix":"Повтори","confidence":"high"} trailing {"ignored":true}',
      usage: { promptTokens: 100, completionTokens: 50 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'A sufficiently long timeout error',
      steps: [],
    });

    expect(result?.rootCause).toBe('Timeout');
    expect(result?.confidence).toBe('high');
  });

  it('returns null when LLM response has no JSON', async () => {
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: 'I cannot diagnose this error.',
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'Some long error message that triggers analysis',
      steps: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when LLM response is missing required fields', async () => {
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({ rootCause: 'Test' }),  // missing explanation, suggestedFix
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'Some long error message',
      steps: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when LLM call throws', async () => {
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockRejectedValue(new Error('LLM unavailable'));

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'Some long error message',
      steps: [],
    });
    expect(result).toBeNull();
  });

  it('normalizes invalid confidence to "low"', async () => {
    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rootCause: 'Test',
        explanation: 'Test',
        suggestedFix: 'Test',
        confidence: 'invalid_value',
      }),
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    } as any);

    const { analyzeTaskFailure } = await import('@/lib/agent/error-analysis');
    const result = await analyzeTaskFailure({
      goal: 'Test',
      errorMessage: 'Long error message here',
      steps: [],
    });
    expect(result?.confidence).toBe('low');
  });
});

describe('error-analysis: analyzeAndStoreFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.agentTask.findUnique.mockReset();
    mockDb.agentTask.update.mockReset();
  });

  it('does not persist when task not found in DB', async () => {
    mockDb.agentTask.findUnique.mockResolvedValue(null);

    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rootCause: 'Test', explanation: 'Test', suggestedFix: 'Test', confidence: 'high',
      }),
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    } as any);

    const { analyzeAndStoreFailure } = await import('@/lib/agent/error-analysis');
    await analyzeAndStoreFailure({
      taskId: 'task-123',
      goal: 'Test',
      errorMessage: 'Long error message',
      steps: [],
    });

    expect(mockDb.agentTask.update).not.toHaveBeenCalled();
  });

  it('persists analysis as JSON in error field', async () => {
    // Task exists with plain string error
    mockDb.agentTask.findUnique.mockResolvedValue({ error: 'Original error message' } as any);

    // use mockGenerateText from hoisted mock
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        rootCause: 'Timeout',
        explanation: 'LLM превысил таймаут',
        suggestedFix: 'Увеличьте LIA_LLM_TIMEOUT_MS',
        confidence: 'medium',
      }),
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    } as any);

    const { analyzeAndStoreFailure } = await import('@/lib/agent/error-analysis');
    await analyzeAndStoreFailure({
      taskId: 'task-456',
      goal: 'Test goal',
      errorMessage: 'Original error message',
      steps: [],
    });

    expect(mockDb.agentTask.update).toHaveBeenCalledTimes(1);
    const updateCall = (mockDb.agentTask.update.mock.calls as any)[0][0] as any;
    expect(updateCall.where.id).toBe('task-456');
    // Error field should now be JSON with both message and analysis
    const parsed = JSON.parse(updateCall.data.error);
    expect(parsed.message).toBe('Original error message');
    expect(parsed.analysis.rootCause).toBe('Timeout');
    expect(parsed.analysis.confidence).toBe('medium');
  });

  it('does not re-analyze if analysis already exists', async () => {
    // Task already has analyzed error
    const existingError = JSON.stringify({
      message: 'Original',
      analysis: { rootCause: 'Existing', explanation: 'x', suggestedFix: 'y', confidence: 'low' },
    });
    mockDb.agentTask.findUnique.mockResolvedValue({ error: existingError } as any);

    const { analyzeAndStoreFailure } = await import('@/lib/agent/error-analysis');
    await analyzeAndStoreFailure({
      taskId: 'task-789',
      goal: 'Test',
      errorMessage: 'Original',
      steps: [],
    });

    // Should not call generateText (skipped before LLM call)
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.agentTask.update).not.toHaveBeenCalled();
  });
});
