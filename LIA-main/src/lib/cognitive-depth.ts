/**
 * Cognitive Depth — adaptive pipeline selection (tier × complexity × mode).
 *
 * Matrix gates **toolsEnabled** + **maxTokens** only.
 * Deliberate LLM pre-calls are permanently off (TTFT / latency pass).
 * Proactive web search is driven by `needsProactiveWebSearch` in task-complexity,
 * not by a dead plan.autoWebSearch flag.
 */

import type { CognitiveParams, Tier } from '@/lib/capability-profile';
import { getTierParams } from '@/lib/capability-profile';
import type { TaskComplexity } from '@/lib/task-complexity';

export type CognitiveMode = 'auto' | 'agent';

export type ExecutionPlan = {
  mode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
  /** Soft budget hint for gates (shouldDeliberate needs calls>=2). Not a multi-pass loop. */
  calls: number;
  deliberate: boolean;
  /** Always false in streaming; kept for plan/header compatibility. */
  selfCheck: boolean;
  maxTokens: number;
  toolsEnabled: boolean;
};

type PlanSlice = Pick<
  ExecutionPlan,
  'calls' | 'deliberate' | 'selfCheck' | 'maxTokens'
>;

const AGENT_PLAN: Omit<ExecutionPlan, 'tier' | 'complexity' | 'maxTokens'> = {
  mode: 'agent',
  // Chat latency pass: no deliberate pre-call on any path (ReAct agent is separate).
  calls: 1,
  deliberate: false,
  // Streaming self-check cannot revise the answer — keep off (quality-log theater).
  selfCheck: false,
  toolsEnabled: true,
};

/** Latency pass: deliberate always off — character via STATIC_CORE + fallback decision. */
const EXECUTION_MATRIX: Record<Tier, Record<TaskComplexity, PlanSlice>> = {
  micro: {
    trivial: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 512 },
    simple: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024 },
    moderate: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
    complex: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
    research: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
  },
  standard: {
    trivial: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 512 },
    simple: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
    moderate: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 4096 },
    complex: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 4096 },
    research: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 4096 },
  },
  plus: {
    trivial: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024 },
    simple: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
    moderate: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 4096 },
    complex: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 8192 },
    research: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 8192 },
  },
  max: {
    trivial: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024 },
    simple: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 },
    moderate: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 8192 },
    complex: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 16384 },
    research: { calls: 1, deliberate: false, selfCheck: false, maxTokens: 16384 },
  },
};

function planAuto(tier: Tier, complexity: TaskComplexity, tierParams: CognitiveParams): ExecutionPlan {
  const slice = EXECUTION_MATRIX[tier][complexity];
  // Latency: no tool schemas on light turns (companion path). Moderate+ keep tools.
  const lightTurn = complexity === 'trivial' || complexity === 'simple';
  return {
    mode: 'auto',
    tier,
    complexity,
    calls: slice.calls,
    deliberate: slice.deliberate,
    selfCheck: slice.selfCheck,
    maxTokens: slice.maxTokens,
    toolsEnabled: tierParams.toolsEnabled && !lightTurn,
  };
}

export function planExecution(params: {
  mode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
}): ExecutionPlan {
  const { mode, tier, complexity } = params;

  if (mode === 'agent') {
    const tierParams = getTierParams(tier);
    return {
      ...AGENT_PLAN,
      tier,
      complexity,
      maxTokens: tierParams.maxTokens,
    };
  }

  return planAuto(tier, complexity, getTierParams(tier));
}

/** Always false — chat latency pass removed deliberate pre-calls. */
export function shouldDeliberate(_plan: ExecutionPlan): boolean {
  return false;
}

/** Always false while streaming: post-hoc LLM check cannot revise the answer. */
export function shouldSelfCheck(_plan: ExecutionPlan): boolean {
  return false;
}
