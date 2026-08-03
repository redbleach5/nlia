/**
 * Policy: when to escalate from day/agent model to heavy.
 *
 * Pure — no DB/Ollama. Callers check heavy is configured before swapping.
 * Pressure / VRAM must never shrink maxSteps (invariant).
 */

import type { TaskComplexity } from '@/lib/task-complexity';

export type EscalateMode = 'chat' | 'agent';
export type EscalateRole = 'day' | 'heavy';

export type EscalateSignals = {
  /** Agent loop detector fired on a prior step. */
  loopDetected?: boolean;
  /** Plan looked weak / fell back to heuristic. */
  weakPlan?: boolean;
  /** Consecutive loop hits — execute may escalate once when ≥ this (default 2). */
  loopCount?: number;
  /** Force escalate (tests / explicit flag). */
  forceHeavy?: boolean;
};

export type EscalateDecision = {
  role: EscalateRole;
  reason: string;
};

const DEFAULT_EXECUTE_LOOP_THRESHOLD = 2;

/**
 * Decide day vs heavy for a brain phase.
 *
 * Default triggers:
 * - complexity research | complex → heavy (agent plan / replan)
 * - loopDetected → heavy for next plan-style brain step
 * - weakPlan → heavy for replan
 * - execute: stay day/agent unless loopCount ≥ N
 * - companion chat stream: never heavy (liveness) — callers use mode:'agent' only
 *
 * If heavy is not configured, callers must ignore role:'heavy' (treat as no-op).
 */
export function decideModelEscalate(params: {
  complexity: TaskComplexity;
  mode: EscalateMode;
  phase: 'main' | 'plan' | 'execute' | 'synthesize' | 'replan';
  signals?: EscalateSignals;
  /** When false, always day (heavy unset). */
  heavyConfigured: boolean;
  executeLoopThreshold?: number;
}): EscalateDecision {
  if (!params.heavyConfigured) {
    return { role: 'day', reason: 'heavy-unset' };
  }

  // Synthesize = Lia face — never heavy (day voice), even if forceHeavy.
  if (params.phase === 'synthesize') {
    return { role: 'day', reason: 'synthesize-day-voice' };
  }

  const signals = params.signals ?? {};
  if (signals.forceHeavy) {
    return { role: 'heavy', reason: 'force' };
  }

  // Execute: tool stability on agent; escalate only after repeated loops.
  if (params.phase === 'execute') {
    const threshold = params.executeLoopThreshold ?? DEFAULT_EXECUTE_LOOP_THRESHOLD;
    const loops = signals.loopCount ?? (signals.loopDetected ? 1 : 0);
    if (loops >= threshold) {
      return { role: 'heavy', reason: `execute-loop>=${threshold}` };
    }
    return { role: 'day', reason: 'execute-stay-agent' };
  }

  if (signals.loopDetected || (signals.loopCount ?? 0) > 0) {
    return { role: 'heavy', reason: 'loop-detected' };
  }
  if (signals.weakPlan && (params.phase === 'plan' || params.phase === 'replan')) {
    return { role: 'heavy', reason: 'weak-plan' };
  }

  if (params.complexity === 'research' || params.complexity === 'complex') {
    return { role: 'heavy', reason: `complexity-${params.complexity}` };
  }

  return { role: 'day', reason: 'default-day' };
}
