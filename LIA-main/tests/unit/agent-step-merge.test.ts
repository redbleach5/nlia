import { describe, expect, it } from 'vitest';
import { mergeAgentSteps } from '@/lib/agent/step-merge';
import type { AgentStepLive } from '@/stores/slices/types';

function step(stepNumber: number, patch: Partial<AgentStepLive> = {}): AgentStepLive {
  return {
    step: stepNumber,
    thought: `thought ${stepNumber}`,
    action: '',
    observation: '',
    ts: stepNumber * 100,
    ...patch,
  };
}

describe('mergeAgentSteps', () => {
  it('hydrates missing steps after a partial SSE stream', () => {
    const current = [step(1, { observation: 'done one' })];
    const persisted = [
      step(1, { observation: 'done one' }),
      step(2, { action: 'read_file', observation: 'done two' }),
    ];

    const merged = mergeAgentSteps(current, persisted);
    expect(merged.map((item) => item.step)).toEqual([1, 2]);
    expect(merged[1].observation).toBe('done two');
  });

  it('completes a live step from its persisted snapshot without duplicates', () => {
    const current = [step(3, { action: 'read_file', observation: '' })];
    const persisted = [step(3, {
      action: 'read_file',
      observation: 'file contents',
      durationMs: 25,
    })];

    const merged = mergeAgentSteps(current, persisted);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      step: 3,
      action: 'read_file',
      observation: 'file contents',
      durationMs: 25,
    });
  });

  it('does not erase newer live fields with an incomplete database snapshot', () => {
    const current = [step(1, { action: 'grep', observation: 'live result' })];
    const persisted = [step(1)];
    expect(mergeAgentSteps(current, persisted)[0]).toMatchObject({
      action: 'grep',
      observation: 'live result',
    });
  });

  it('returns the same array when the snapshot adds no information', () => {
    const current = [step(1, { observation: 'same' })];
    const persisted = [step(1, { observation: 'same' })];
    expect(mergeAgentSteps(current, persisted)).toBe(current);
  });
});
