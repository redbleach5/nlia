import { describe, expect, it } from 'vitest';
import {
  displayAgentGoal,
  extractLegacyTemplateOverlay,
  withTemplateOverlay,
} from '@/lib/agent/goal-display';

describe('goal-display', () => {
  it('keeps clean user goals unchanged', () => {
    expect(displayAgentGoal('напиши игру тетрис')).toBe('напиши игру тетрис');
  });

  it('strips legacy ## ЗАДАЧА template prefix', () => {
    const raw = `Ты — Coding Agent. Правила:\n- полный код\n\n## ЗАДАЧА\nнапиши тетрис`;
    expect(displayAgentGoal(raw)).toBe('напиши тетрис');
    expect(extractLegacyTemplateOverlay(raw)).toContain('Coding Agent');
  });

  it('withTemplateOverlay prepends overlay for LLM system channel', () => {
    const out = withTemplateOverlay('Ты — планировщик.', 'Ты — Coding Agent.');
    expect(out.startsWith('Ты — Coding Agent.')).toBe(true);
    expect(out).toContain('Ты — планировщик.');
    expect(out).toContain('---');
  });

  it('withTemplateOverlay is a no-op for empty overlay', () => {
    expect(withTemplateOverlay('base', '')).toBe('base');
    expect(withTemplateOverlay('base', null)).toBe('base');
  });
});
