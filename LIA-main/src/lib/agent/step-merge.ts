import type { AgentStepLive } from '@/stores/slices/types';

/**
 * Merge the persisted task snapshot into possibly partial SSE state.
 * Persisted non-empty fields complete a live step; live-only fields survive
 * while the database snapshot is catching up. The result is ordered and
 * deduplicated by step number.
 */
export function mergeAgentSteps(
  current: AgentStepLive[],
  persisted: AgentStepLive[],
): AgentStepLive[] {
  if (persisted.length === 0) return current;

  const byStep = new Map(current.map((step) => [step.step, step]));
  for (const snapshot of persisted) {
    const live = byStep.get(snapshot.step);
    if (!live) {
      byStep.set(snapshot.step, snapshot);
      continue;
    }
    byStep.set(snapshot.step, {
      ...live,
      thought: snapshot.thought || live.thought,
      action: snapshot.action || live.action,
      observation: snapshot.observation || live.observation,
      durationMs: snapshot.durationMs ?? live.durationMs,
      tools: snapshot.tools?.length ? snapshot.tools : live.tools,
      ts: live.ts || snapshot.ts,
    });
  }

  const merged = [...byStep.values()].sort((a, b) => a.step - b.step);
  const unchanged = merged.length === current.length && merged.every((step, index) => {
    const previous = current[index];
    return previous
      && previous.step === step.step
      && previous.thought === step.thought
      && previous.action === step.action
      && previous.observation === step.observation
      && previous.durationMs === step.durationMs
      && previous.tools === step.tools
      && previous.ts === step.ts;
  });
  return unchanged ? current : merged;
}
