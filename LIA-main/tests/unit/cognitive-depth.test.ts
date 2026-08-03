import { describe, it, expect } from 'vitest';
import {
  planExecution,
  shouldDeliberate,
  shouldSelfCheck,
  type ExecutionPlan,
} from '@/lib/cognitive-depth';
import type { TaskComplexity } from '@/lib/task-complexity';

function plan(tier: 'micro' | 'standard' | 'plus' | 'max', complexity: TaskComplexity) {
  return planExecution({ mode: 'auto', tier, complexity });
}

describe('planExecution', () => {
  it('agent mode returns agent plan with tools; deliberate always off (latency pass)', () => {
    const p = planExecution({
      mode: 'agent',
      tier: 'standard',
      complexity: 'moderate',
    });
    expect(p.mode).toBe('agent');
    expect(p.toolsEnabled).toBe(true);
    expect(p.deliberate).toBe(false);
    expect(p.selfCheck).toBe(false);
    expect(p.calls).toBe(1);
    expect(p.maxTokens).toBe(4096); // standard tierParams.maxTokens
    expect(shouldDeliberate(p)).toBe(false);
    expect(shouldSelfCheck(p)).toBe(false);
  });

  it('agent mode maxTokens follows tier (max)', () => {
    const p = planExecution({
      mode: 'agent',
      tier: 'max',
      complexity: 'complex',
    });
    expect(p.maxTokens).toBe(16384);
  });

  describe('standard tier — latency pass: no deliberate; tools off on light turns', () => {
    it.each(['trivial', 'simple', 'moderate', 'complex', 'research'] as TaskComplexity[])(
      'complexity=%s: deliberate off, single-call',
      (complexity) => {
        const p = plan('standard', complexity);
        expect(p.deliberate).toBe(false);
        expect(p.selfCheck).toBe(false);
        expect(p.calls).toBe(1);
        expect(shouldDeliberate(p)).toBe(false);
      },
    );

    it('tools off on trivial/simple; on for moderate+', () => {
      expect(plan('standard', 'trivial').toolsEnabled).toBe(false);
      expect(plan('standard', 'simple').toolsEnabled).toBe(false);
      expect(plan('standard', 'moderate').toolsEnabled).toBe(true);
    });
  });

  describe('plus tier — deliberate always off', () => {
    it('moderate is single-call without deliberate', () => {
      const p = plan('plus', 'moderate');
      expect(p.calls).toBe(1);
      expect(p.deliberate).toBe(false);
      expect(p.selfCheck).toBe(false);
      expect(p.maxTokens).toBe(4096);
    });

    it('trivial stays single-call without deliberate', () => {
      const p = plan('plus', 'trivial');
      expect(p.calls).toBe(1);
      expect(p.deliberate).toBe(false);
    });
  });

  describe('max tier — highest token budgets, no deliberate', () => {
    it('complex uses 16k max tokens, single call', () => {
      const p = plan('max', 'complex');
      expect(p.calls).toBe(1);
      expect(p.deliberate).toBe(false);
      expect(p.maxTokens).toBe(16384);
    });
  });

  describe('micro tier', () => {
    it('trivial uses minimal maxTokens', () => {
      expect(plan('micro', 'trivial').maxTokens).toBe(512);
    });
  });

  it('includes tier and complexity on every auto plan', () => {
    const p = plan('standard', 'simple');
    expect(p.tier).toBe('standard');
    expect(p.complexity).toBe('simple');
    expect(p.mode).toBe('auto');
  });
});

describe('shouldDeliberate', () => {
  it('is always false (latency pass)', () => {
    expect(shouldDeliberate(plan('standard', 'moderate'))).toBe(false);
    expect(shouldDeliberate(plan('plus', 'moderate'))).toBe(false);
    expect(shouldDeliberate(plan('max', 'research'))).toBe(false);
  });

  it('stays false even if a plan claims deliberate with calls>=2', () => {
    const p: ExecutionPlan = {
      ...plan('plus', 'trivial'),
      deliberate: true,
      calls: 2,
    };
    expect(shouldDeliberate(p)).toBe(false);
  });
});

describe('shouldSelfCheck', () => {
  it('is always false — streaming cannot revise the answer', () => {
    expect(shouldSelfCheck(plan('standard', 'moderate'))).toBe(false);
    expect(shouldSelfCheck(plan('plus', 'moderate'))).toBe(false);
    expect(shouldSelfCheck(plan('max', 'research'))).toBe(false);
  });

  it('stays false even if a plan claims selfCheck with calls>=2', () => {
    const p: ExecutionPlan = {
      ...plan('plus', 'complex'),
      selfCheck: true,
      calls: 4,
    };
    expect(shouldSelfCheck(p)).toBe(false);
  });
});
