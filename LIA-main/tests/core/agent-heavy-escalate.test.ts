/**
 * Integration-style mocks: assert which Ollama model each agent phase uses
 * when heavy is configured (brain = heavy, face = day).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentTask } from '@/lib/agent/task';

const {
  getChatModel,
  getAgentModel,
  getHeavyModelName,
  getModelName,
  getAgentModelName,
  streamTextMock,
  planResponses,
} = vi.hoisted(() => {
  const getChatModel = vi.fn(async (override?: string) => ({
    modelId: override ?? 'day:14b',
  }));
  const getAgentModel = vi.fn(async () => ({ modelId: 'agent:14b' }));
  const getHeavyModelName = vi.fn(async (): Promise<string | null> => 'heavy:70b');
  const getModelName = vi.fn(async () => 'day:14b');
  const getAgentModelName = vi.fn(async () => 'agent:14b');
  /** Queue of plan LLM texts (shift per plan streamText). */
  const planResponses: string[] = [];

  const streamTextMock = vi.fn((params: {
    system?: string;
    model?: { modelId?: string };
  }) => {
    const sys = params.system ?? '';
    let text: string;
    if (sys.includes('планировщик')) {
      text = planResponses.shift()
        ?? JSON.stringify({
          goal: 'g',
          steps: ['Шаг один: собрать данные', 'Шаг два: сделать вывод'],
          needsTools: true,
          complexity: 'high',
        });
    } else if (sys.includes('После цикла') || sys.includes('синтез') || sys.includes('итогов')) {
      text = 'Краткий ответ пользователю.';
    } else {
      text = 'ГОТОВО: ok';
    }
    return {
      text: Promise.resolve(text),
      toTextStreamResponse: () => new Response(text),
    };
  });

  return {
    getChatModel,
    getAgentModel,
    getHeavyModelName,
    getModelName,
    getAgentModelName,
    streamTextMock,
    planResponses,
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('@/lib/ollama', () => ({
  getChatModel,
  getAgentModel,
  getHeavyModelName,
  getModelName,
  getAgentModelName,
  setOllamaNumCtx: vi.fn(),
  setOllamaKeepAlive: vi.fn(),
}));

vi.mock('@/lib/chat/inference-ctx', () => ({
  applyOllamaNumCtxForRole: vi.fn(async () => 8192),
  poolOptsFromProfile: vi.fn(() => ({})),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});

vi.mock('@/lib/agent/explore-probe', () => ({
  buildCodebaseSketch: vi.fn(async () => ''),
}));

vi.mock('@/lib/agent/coding-brief', () => ({
  loadCodingBriefPromptBlock: vi.fn(async () => null),
  saveCodingTaskBrief: vi.fn(async () => {}),
}));

function fakeTask(goal: string): AgentTask {
  return {
    id: 'task-heavy-test',
    episodeId: 'ep-1',
    goal,
    templateName: null,
    systemOverlay: '',
    status: 'planning',
    planJson: null,
    currentStep: 0,
    stepsJson: '[]',
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
    error: null,
    resultSummary: null,
    maxSteps: 10,
    maxDurationSec: 600,
    checkpointJson: null,
    fsScope: null,
    applyMode: 'ask',
  } as AgentTask;
}

describe('agent heavy escalate (phase model selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planResponses.length = 0;
    getHeavyModelName.mockResolvedValue('heavy:70b');
  });

  it('PLAN on research goal uses heavy model', async () => {
    const { generatePlan } = await import('@/lib/agent/runner-helpers');
    await generatePlan(
      fakeTask('Найди информацию и сравни подходы к исследованию архитектуры'),
      '- mock_tool: x',
      AbortSignal.timeout(5000),
    );

    expect(getChatModel).toHaveBeenCalledWith('heavy:70b');
    expect(getAgentModel).not.toHaveBeenCalled();
  });

  it('PLAN on simple goal stays on agent model', async () => {
    const { generatePlan } = await import('@/lib/agent/runner-helpers');
    await generatePlan(
      fakeTask('Скажи привет'),
      '- mock_tool: x',
      AbortSignal.timeout(5000),
    );

    expect(getAgentModel).toHaveBeenCalled();
    expect(getChatModel).not.toHaveBeenCalledWith('heavy:70b');
  });

  it('weak/degenerate plan triggers replan on heavy', async () => {
    // First attempt: valid schema but degenerate duplicate steps → fallback → weakPlan replan
    planResponses.push(JSON.stringify({
      goal: 'g',
      steps: ['одно и то же', 'одно и то же', 'одно и то же', 'одно и то же'],
      needsTools: false,
      complexity: 'low',
    }));
    // Second attempt (heavy): good plan
    planResponses.push(JSON.stringify({
      goal: 'g',
      steps: ['Сначала list_tree', 'Потом read_file'],
      needsTools: true,
      complexity: 'medium',
    }));

    const { generatePlan } = await import('@/lib/agent/runner-helpers');
    const plan = await generatePlan(
      fakeTask('Сделай мелочь'), // simple → first plan on agent
      '- mock_tool: x',
      AbortSignal.timeout(5000),
    );

    expect(getAgentModel).toHaveBeenCalled();
    expect(getChatModel).toHaveBeenCalledWith('heavy:70b');
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]).toMatch(/list_tree/i);
  });

  it('SYNTHESIZE uses day chat model when heavy configured (Lia face)', async () => {
    const { synthesize } = await import('@/lib/agent/runner-helpers');
    await synthesize(
      fakeTask('Проанализируй архитектуру сервиса'),
      { goal: 'g', steps: ['a', 'b'] },
      [{ thought: 't', action: 'reason', observation: 'enough material here for synthesis phase' }],
      [],
      AbortSignal.timeout(5000),
    );

    // Day voice: getChatModel() with no heavy override
    expect(getChatModel).toHaveBeenCalled();
    const heavyCalls = getChatModel.mock.calls.filter((c) => c[0] === 'heavy:70b');
    expect(heavyCalls).toHaveLength(0);
    expect(getAgentModel).not.toHaveBeenCalled();
  });

  it('with heavy unset, PLAN stays agent and SYNTHESIZE uses agent', async () => {
    getHeavyModelName.mockResolvedValue(null);
    const { generatePlan, synthesize } = await import('@/lib/agent/runner-helpers');

    await generatePlan(
      fakeTask('Найди информацию по документации API'),
      '- mock_tool: x',
      AbortSignal.timeout(5000),
    );
    expect(getAgentModel).toHaveBeenCalled();
    expect(getChatModel).not.toHaveBeenCalledWith('heavy:70b');

    getAgentModel.mockClear();
    getChatModel.mockClear();

    await synthesize(
      fakeTask('Найди информацию по документации API'),
      { goal: 'g', steps: ['a'] },
      [{ thought: 't', action: 'reason', observation: 'obs' }],
      [],
      AbortSignal.timeout(5000),
    );
    expect(getAgentModel).toHaveBeenCalled();
  });
});
