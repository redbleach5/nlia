import { describe, expect, it } from 'vitest';
import {
  compactStepLine,
  formatAgentStepHistory,
  AGENT_RECENT_STEPS,
} from '@/lib/agent/step-history-compact';

describe('step-history-compact', () => {
  it('compactStepLine prefers thought then observation', () => {
    expect(compactStepLine({
      thought: 'Нужно прочитать runner',
      action: 'read_file',
      observation: 'huge output '.repeat(50),
    }, 3)).toMatch(/^3\. \[read_file\] Нужно прочитать runner/);
  });

  it('formatAgentStepHistory keeps last N full and compacts older', () => {
    const steps = Array.from({ length: AGENT_RECENT_STEPS + 3 }, (_, i) => ({
      thought: `thought-${i + 1}`,
      action: i % 2 === 0 ? 'grep' : 'read_file',
      observation: `observation-${i + 1} ` + 'x'.repeat(300),
    }));

    const out = formatAgentStepHistory(steps, (_a, o) => o.slice(0, 50));

    expect(out).toMatch(/Сжатый контекст ранних шагов/);
    expect(out).toMatch(/Инструменты: grep, read_file/);
    expect(out).toMatch(/1\. \[grep\]/);
    expect(out).toMatch(/Недавние шаги \(подробно\)/);
    expect(out).toMatch(`Шаг ${AGENT_RECENT_STEPS + 3}:`);
    // Older observations should not dump full 300+ chars in compact block
    const compactBlock = out.split('Недавние шаги')[0];
    expect(compactBlock.length).toBeLessThan(steps.slice(0, 3).reduce((n, s) => n + s.observation.length, 0));
  });

  it('formatAgentStepHistory with few steps is all detailed', () => {
    const out = formatAgentStepHistory([
      { thought: 'a', action: 'list_tree', observation: 'tree' },
    ], (_a, o) => o);
    expect(out).toMatch(/Шаг 1: \[list_tree\]/);
    expect(out).not.toMatch(/Сжатый контекст/);
  });
});
