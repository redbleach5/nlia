import { describe, expect, it } from 'vitest';
import { PATHS } from '@/lib/paths';
import {
  describeFsScopeForPrompt,
  fallbackPlan,
  isSandboxFsScope,
} from '@/lib/agent/runner-helpers';
import type { AgentTask } from '@/lib/agent/task';

function fakeTask(goal: string, fsScope: string | null = null): AgentTask {
  return {
    id: 't1',
    episodeId: 'e1',
    goal,
    status: 'pending',
    planJson: null,
    stepsJson: '[]',
    currentStep: 0,
    maxSteps: 25,
    maxDurationSec: 3600,
    resultSummary: null,
    error: null,
    toolsWhitelist: null,
    fsScope,
    checkpointJson: null,
    artifactsJson: '[]',
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentTask;
}

describe('sandbox + fallbackPlan', () => {
  it('detects agent-workspaces as sandbox', () => {
    expect(isSandboxFsScope('C:/x/download/agent-workspaces/task-1')).toBe(true);
    expect(isSandboxFsScope('/home/proj/src')).toBe(false);
    expect(isSandboxFsScope(null)).toBe(false);
  });

  it('describes sandbox honestly', () => {
    const d = describeFsScopeForPrompt('/tmp/download/agent-workspaces/task-9');
    expect(d).toMatch(/sandbox/i);
    expect(d).toMatch(/search_codebase/);
  });

  it('fallbackPlan for code exploration without project fs uses KB/codebase tools', () => {
    const plan = fallbackPlan(fakeTask('Изучи проект Lia-v2-public, какие в нем основные проблемы'));
    expect(plan.steps.some(s => /list_sources|search_codebase/i.test(s))).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('fallbackPlan for exploration with project fs uses list_tree/grep/read_file', () => {
    const plan = fallbackPlan(fakeTask(
      'Изучи проект и найди проблемы',
      PATHS.root,
    ));
    expect(plan.steps.some(s => /list_tree/i.test(s))).toBe(true);
    expect(plan.steps.some(s => /grep/i.test(s))).toBe(true);
  });

  it('describes project workspace with grep strategy', () => {
    const d = describeFsScopeForPrompt(PATHS.root);
    expect(d).toMatch(/list_tree/i);
    expect(d).toMatch(/grep/i);
  });

  it('fallbackPlan for pure KB lookup stays on KB tools', () => {
    const plan = fallbackPlan(fakeTask('Найди описание протокола EGTS в базе знаний'));
    expect(plan.steps.some(s => /search_sources|list_sources/i.test(s))).toBe(true);
  });

  it('fallbackPlan for create-from-scratch uses write + runtime (static preset)', () => {
    const plan = fallbackPlan(fakeTask('Напиши игру тетрис в неоновом стиле'));
    expect(plan.steps.some(s => /write_file|index\.html/i.test(s))).toBe(true);
    expect(plan.steps.some(s => /runtime_start/i.test(s))).toBe(true);
    expect(plan.steps.some(s => /проанализировать задачу/i.test(s))).toBe(false);
  });

  it('sandbox create goals steer toward write_file, not codebase search', () => {
    const d = describeFsScopeForPrompt(
      '/tmp/download/agent-workspaces/task-9',
      'Напиши игру тетрис',
    );
    expect(d).toMatch(/write_file/i);
    expect(d).not.toMatch(/search_codebase/);
  });
});
