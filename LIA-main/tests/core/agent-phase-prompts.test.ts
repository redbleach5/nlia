import { describe, expect, it } from 'vitest';
import {
  assertOperationalAgentPrompt,
  buildExecuteSystemPrompt,
  buildPlanSystemPrompt,
  buildSynthesizeSystemPrompt,
  promptLooksLikeCompanionSystem,
} from '@/lib/agent/phase-prompts';

describe('agent phase prompt isolation', () => {
  it('plan system has no companion identity', () => {
    const p = buildPlanSystemPrompt({
      toolDescriptions: '- read_file',
      maxSteps: 8,
      fsHint: 'fsScope: /tmp/x',
      explorationHint: '',
      kbOnlyHint: '',
      createHint: '',
      fixHint: '',
    });
    expect(assertOperationalAgentPrompt(p)).toBe(true);
    expect(p).toContain('планировщик');
    expect(p.toLowerCase()).not.toContain('агент лия');
  });

  it('execute system has no companion identity', () => {
    const p = buildExecuteSystemPrompt({
      userGoal: 'почини ssrf',
      planGoal: 'почини ssrf',
      planStr: '1. read_file',
      toolDescriptions: '- read_file',
      contextStr: '',
      fsHint: 'Workspace: /repo',
      mode: 'explore_external',
    });
    expect(assertOperationalAgentPrompt(p)).toBe(true);
    expect(p).toContain('исполнитель плана');
    expect(promptLooksLikeCompanionSystem(p)).toBe(false);
  });

  it('kb execute stays operational', () => {
    const p = buildExecuteSystemPrompt({
      userGoal: 'что в KB про X',
      planGoal: 'поиск',
      planStr: '1. search_sources',
      toolDescriptions: '- search_sources',
      contextStr: '',
      fsHint: '',
      mode: 'kb',
    });
    expect(assertOperationalAgentPrompt(p)).toBe(true);
  });

  it('synthesize default may use light Lia voice', () => {
    const p = buildSynthesizeSystemPrompt('default');
    expect(p.toLowerCase()).toContain('ты — лия');
    expect(promptLooksLikeCompanionSystem(p)).toBe(true);
  });

  it('grounded KB synthesize has no identity markers', () => {
    const p = buildSynthesizeSystemPrompt('grounded_kb');
    expect(assertOperationalAgentPrompt(p)).toBe(true);
  });
});
