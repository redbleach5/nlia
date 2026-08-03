import { describe, it, expect } from 'vitest';
import { decideModelEscalate } from '@/lib/llm/model-escalate';

describe('decideModelEscalate weakPlan', () => {
  it('escalates replan when weakPlan and heavy configured', () => {
    const d = decideModelEscalate({
      complexity: 'simple',
      mode: 'agent',
      phase: 'replan',
      heavyConfigured: true,
      signals: { weakPlan: true },
    });
    expect(d).toEqual({ role: 'heavy', reason: 'weak-plan' });
  });

  it('does not escalate replan when heavy unset', () => {
    const d = decideModelEscalate({
      complexity: 'simple',
      mode: 'agent',
      phase: 'replan',
      heavyConfigured: false,
      signals: { weakPlan: true },
    });
    expect(d.role).toBe('day');
  });
});
