import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTestEpisode,
  deleteTestEpisode,
  createTestAgentTask,
} from './helpers';
import type { AgentEvent } from '@/lib/agent/events';
import { getAgentTask } from '@/lib/agent/task';

// ── Hoisted mocks ──

const { streamTextMock, streamModeRef, planCallCountRef } = vi.hoisted(() => {
  const streamModeRef = { current: 'normal' as 'normal' | 'step-error' | 'step-continue' };
  const planCallCountRef = { current: 0 };

  function resolveAgentText(system: string | undefined, messages: Array<{ role: string; content: string }> | undefined): string {
    const sys = system ?? '';
    if (sys.includes('планировщик')) {
      planCallCountRef.current++;
      return JSON.stringify({
        goal: 'Тест',
        steps: ['Выполнить задачу'],
        needsTools: false,
        complexity: 'low',
      });
    }
    if (sys.includes('После цикла исследований')) {
      return 'Итоговый ответ: задача выполнена.';
    }
    if (streamModeRef.current === 'step-error') {
      return '';
    }
    if (streamModeRef.current === 'step-continue') {
      return 'Промежуточный шаг — продолжаю работу.';
    }
    return 'ГОТОВО: задача выполнена на этом шаге.';
  }

  const streamTextMock = vi.fn((params: {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    onError?: (err: { message?: string }) => void;
    onFinish?: (data: unknown) => void | Promise<void>;
  }) => {
    const sys = params.system ?? '';
    const text = resolveAgentText(sys, params.messages);
    const defer = streamModeRef.current === 'step-continue'
      && !sys.includes('планировщик')
      && !sys.includes('После цикла');

    if (streamModeRef.current === 'step-error' && !sys.includes('планировщик') && !sys.includes('После цикла')) {
      params.onError?.({ message: '403 Forbidden' });
      return {
        text: Promise.reject(new Error('No output generated')),
        toTextStreamResponse: () => new Response('', { headers: new Headers() }),
      };
    }

    const textPromise = defer
      ? new Promise<string>(resolve => setTimeout(() => resolve(text), 15))
      : Promise.resolve(text);

    return {
      text: textPromise,
      toTextStreamResponse: () => new Response(text, { headers: new Headers() }),
    };
  });

  return { streamTextMock, streamModeRef, planCallCountRef };
});

type LoopSignal =
  | { kind: 'pattern'; tool: string; input: unknown; count: number; message: string }
  | { kind: 'empty'; count: number; message: string }
  | { kind: 'semantic'; similarity: number; message: string }
  | null;

const detectLoopMock = vi.fn(async (): Promise<LoopSignal> => null);
const waitForUserInputMock = vi.fn(async () => 'продолжай');

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('@/lib/ollama', () => ({
  getChatModel: vi.fn(async () => ({ modelId: 'mock-model' })),
  getAgentModel: vi.fn(async () => ({ modelId: 'mock-model' })),
  getModelName: vi.fn(async () => 'qwen2.5:7b'),
  getAgentModelName: vi.fn(async () => 'qwen2.5:7b'),
  checkLlmPreflight: vi.fn(async () => ({
    ok: true as const,
    provider: 'ollama' as const,
    model: 'mock:7b',
    ollama: { ok: true, models: ['qwen2.5:7b'] },
  })),
  embed: vi.fn(async () => new Float32Array(768).fill(0.1)),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});

vi.mock('@/lib/agent/tools', () => ({
  buildAgentTools: vi.fn(() => ({})),
  describeTools: vi.fn(() => '- mock_tool: тестовый инструмент'),
}));

vi.mock('@/lib/memory/vector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/memory/vector')>();
  return {
    ...actual,
    recall: vi.fn(async () => []),
    remember: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/memory/facts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/memory/facts')>();
  return {
    ...actual,
    getEpisodeFacts: vi.fn(async () => []),
  };
});

vi.mock('@/lib/agent/error-analysis', () => ({
  analyzeAndStoreFailure: vi.fn(async () => {}),
}));

vi.mock('@/lib/agent/loop-detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/loop-detector')>();
  return { ...actual, detectLoop: detectLoopMock };
});

vi.mock('@/lib/agent/wait-input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/wait-input')>();
  return { ...actual, waitForUserInput: waitForUserInputMock };
});

function buildCheckpoint(stepsDone = 1) {
  const plan = {
    goal: 'Resume goal',
    steps: ['Шаг 1', 'Шаг 2'],
    needsTools: false,
    complexity: 'low' as const,
  };
  const steps = Array.from({ length: stepsDone }, (_, i) => ({
    thought: `thought ${i + 1}`,
    action: 'reason',
    input: {},
    observation: `observation ${i + 1} with enough length`,
    ts: Date.now() - (stepsDone - i) * 1000,
  }));
  return { plan, steps, savedAt: Date.now() };
}

describe('runAgentTask (core contracts)', () => {
  let episodeId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    streamModeRef.current = 'normal';
    planCallCountRef.current = 0;
    detectLoopMock.mockResolvedValue(null);
    waitForUserInputMock.mockResolvedValue('продолжай');
    episodeId = await createTestEpisode('agent-core');
  });

  afterEach(async () => {
    await deleteTestEpisode(episodeId);
  });

  it('new task: plan → step → synthesize → status done', async () => {
    const taskId = await createTestAgentTask(episodeId, { goal: 'Скажи привет', maxSteps: 3 });

    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);

    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('done');
    expect(task?.resultSummary).toContain('Итоговый ответ');
    const steps = JSON.parse(task!.stepsJson) as unknown[];
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(planCallCountRef.current).toBe(1);
  });

  it('checkpoint resume: skips PLAN and continues from saved steps', async () => {
    const { plan, steps, savedAt } = buildCheckpoint(1);
    const checkpointJson = JSON.stringify({ plan, steps, savedAt });
    const taskId = await createTestAgentTask(episodeId, {
      goal: plan.goal,
      maxSteps: 5,
      status: 'pending',
      checkpointJson,
      planJson: JSON.stringify(plan),
      stepsJson: JSON.stringify(steps),
      currentStep: 1,
    });

    planCallCountRef.current = 0;
    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);

    expect(planCallCountRef.current).toBe(0);

    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('done');
    const finalSteps = JSON.parse(task!.stepsJson) as unknown[];
    expect(finalSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('sweepStaleTasks resets executing+checkpoint to pending; runner resumes', async () => {
    const { plan, steps, savedAt } = buildCheckpoint(1);
    const checkpointJson = JSON.stringify({ plan, steps, savedAt });
    const taskId = await createTestAgentTask(episodeId, {
      goal: plan.goal,
      maxSteps: 5,
      status: 'executing',
      checkpointJson,
      stepsJson: JSON.stringify(steps),
      currentStep: 1,
    });

    const { sweepStaleTasks, runAgentTask } = await import('@/lib/agent/runner');
    const swept = await sweepStaleTasks();
    expect(swept).toBeGreaterThanOrEqual(1);

    const afterSweep = await getAgentTask(taskId);
    expect(afterSweep?.status).toBe('pending');
    expect(afterSweep?.checkpointJson).toBeTruthy();

    planCallCountRef.current = 0;
    await runAgentTask(taskId);

    expect(planCallCountRef.current).toBe(0);
    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('done');
  });

  it('circuit breaker: 3 consecutive stream errors → task failed', async () => {
    streamModeRef.current = 'step-error';
    const taskId = await createTestAgentTask(episodeId, {
      goal: 'Задача с ошибками LLM',
      maxSteps: 5,
    });

    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);

    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toMatch(/LLM не отвечает|3 шага подряд/i);
  });

  it('cancel between steps → status cancelled', async () => {
    streamModeRef.current = 'step-continue';
    const taskId = await createTestAgentTask(episodeId, {
      goal: 'Долгая задача',
      maxSteps: 8,
    });

    const { runAgentTask } = await import('@/lib/agent/runner');
    const { signalCancellation } = await import('@/lib/agent/events');

    const runPromise = runAgentTask(taskId);

    const deadline = Date.now() + 5000;
    // Yield to runner — step-continue defers streamText with setTimeout(15ms)
    while (Date.now() < deadline) {
      const mid = await getAgentTask(taskId);
      const stepCount = mid ? (JSON.parse(mid.stepsJson) as unknown[]).length : 0;
      if (stepCount >= 1 && mid?.status === 'executing') break;
      await new Promise(r => setTimeout(r, 10));
    }

    signalCancellation(taskId);
    await runPromise;

    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('cancelled');
  });

  it('loop detected → strategy hint then ask_user on empty FS pattern', async () => {
    // First empty-FS pattern → inject strategy_hint (no ask_user yet).
    // Second detection → ask_user.
    detectLoopMock
      .mockResolvedValueOnce({
        kind: 'pattern',
        tool: 'list_tree',
        input: {},
        count: 2,
        message: 'pattern loop',
      })
      .mockResolvedValueOnce({
        kind: 'pattern',
        tool: 'list_tree',
        input: {},
        count: 2,
        message: 'pattern loop again',
      });

    streamModeRef.current = 'step-continue';
    const taskId = await createTestAgentTask(episodeId, { goal: 'Застряла', maxSteps: 6 });

    const events: AgentEvent[] = [];
    const { subscribeToTask } = await import('@/lib/agent/events');
    const unsub = subscribeToTask(taskId, (e) => events.push(e));

    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);
    unsub();

    expect(detectLoopMock).toHaveBeenCalled();
    expect(waitForUserInputMock).toHaveBeenCalled();
    const task = await getAgentTask(taskId);
    const steps = JSON.parse(task!.stepsJson) as Array<{ action: string }>;
    expect(steps.some(s => s.action === 'strategy_hint')).toBe(true);
    expect(events.some(e => e.type === 'task_waiting_input' || e.type === 'task_done')).toBe(true);
  });

  it('semantic loop → strategy hint first, then ask_user', async () => {
    detectLoopMock
      .mockResolvedValueOnce({
        kind: 'semantic',
        similarity: 0.92,
        message: 'semantic loop',
      })
      .mockResolvedValueOnce({
        kind: 'semantic',
        similarity: 0.93,
        message: 'semantic loop again',
      });

    streamModeRef.current = 'step-continue';
    const taskId = await createTestAgentTask(episodeId, { goal: 'Застряла семантически', maxSteps: 6 });

    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);

    expect(waitForUserInputMock).toHaveBeenCalled();
    const task = await getAgentTask(taskId);
    const steps = JSON.parse(task!.stepsJson) as Array<{ action: string }>;
    expect(steps.some(s => s.action === 'strategy_hint')).toBe(true);
  });

  it('max steps without ГОТОВО → still synthesizes and completes', async () => {
    streamModeRef.current = 'step-continue';
    const taskId = await createTestAgentTask(episodeId, {
      goal: 'Много шагов',
      maxSteps: 2,
    });

    const { runAgentTask } = await import('@/lib/agent/runner');
    await runAgentTask(taskId);

    const task = await getAgentTask(taskId);
    expect(task?.status).toBe('done');
    expect(task?.resultSummary).toContain('Итоговый ответ');
    const steps = JSON.parse(task!.stepsJson) as unknown[];
    expect(steps.length).toBe(2);
  });
});

describe('resumeFromCheckpoint (unit)', () => {
  it('returns null for corrupt checkpoint JSON', async () => {
    const episodeId = await createTestEpisode('resume-unit');
    const taskId = await createTestAgentTask(episodeId, {
      checkpointJson: '{not-json',
      status: 'pending',
    });

    try {
      const { resumeFromCheckpoint } = await import('@/lib/agent/runner-helpers');
      const { getAgentTask } = await import('@/lib/agent/task');
      const task = await getAgentTask(taskId);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

      const result = await resumeFromCheckpoint(taskId, task!, log);
      expect(result).toBeNull();
    } finally {
      await deleteTestEpisode(episodeId);
    }
  });
});

describe('runner state across module reloads', () => {
  it('reuses the active AbortController registry after HMR', async () => {
    const taskId = `hmr-${Date.now()}`;
    const firstModule = await import('@/lib/agent/runner');
    const firstSignal = firstModule.getTaskAbortSignal(taskId);

    vi.resetModules();
    const reloadedModule = await import('@/lib/agent/runner');
    const reloadedSignal = reloadedModule.getTaskAbortSignal(taskId);

    expect(reloadedSignal).toBe(firstSignal);
    await reloadedModule.cancelAgentTaskRun(taskId);
    expect(reloadedSignal.aborted).toBe(true);
  });
});
