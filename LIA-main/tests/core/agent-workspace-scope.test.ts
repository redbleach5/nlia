import { describe, expect, it, afterEach, vi } from 'vitest';
import { resolve } from 'path';
import { PATHS } from '@/lib/paths';
import {
  isProjectRootFsScope,
  resolveAgentFsScope,
  wantsProjectWorkspace,
  goalMentionsLiaSelf,
} from '@/lib/agent/workspace-scope';
import {
  describeFsScopeForPrompt,
  fallbackPlan,
  isSandboxFsScope,
} from '@/lib/agent/runner-helpers';
import type { AgentTask } from '@/lib/agent/task';

vi.mock('@/lib/db', () => ({
  db: {
    source: {
      findMany: vi.fn(async () => []),
    },
  },
}));

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

describe('workspace-scope', () => {
  const prevSandbox = process.env.LIA_AGENT_SANDBOX_ONLY;
  const prevMount = process.env.LIA_AGENT_MOUNT_SELF;
  const prevDefault = process.env.LIA_AGENT_DEFAULT_WORKSPACE;

  afterEach(() => {
    for (const [k, v] of [
      ['LIA_AGENT_SANDBOX_ONLY', prevSandbox],
      ['LIA_AGENT_MOUNT_SELF', prevMount],
      ['LIA_AGENT_DEFAULT_WORKSPACE', prevDefault],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('wantsProjectWorkspace for exploration and fix goals', () => {
    expect(wantsProjectWorkspace('Изучи проект и найди проблемы')).toBe(true);
    expect(wantsProjectWorkspace('Исправь баг в runner.ts')).toBe(true);
    expect(wantsProjectWorkspace('Найди описание EGTS в базе знаний')).toBe(false);
  });

  it('goalMentionsLiaSelf detects Lia targets', () => {
    expect(goalMentionsLiaSelf('Изучи Lia-v2-public')).toBe(true);
    expect(goalMentionsLiaSelf('Исправь баг в проекте Лии')).toBe(true);
    expect(goalMentionsLiaSelf('Изучи себя досконально')).toBe(false);
    expect(goalMentionsLiaSelf('Изучи AgentsRise')).toBe(false);
    expect(goalMentionsLiaSelf('У тебя есть этот проект в базе знаний')).toBe(false);
    expect(goalMentionsLiaSelf('изучи свой код')).toBe(false);
  });

  it('does NOT mount Lia for «этот проект» phrasing', async () => {
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;
    const r = await resolveAgentFsScope({
      goal: 'У тебя есть этот проект в базе знаний, изучи его',
      explicitFsScope: null,
    });
    expect(r.kind).not.toBe('project');
    expect(isProjectRootFsScope(r.fsScope)).toBe(false);
  });

  it('does NOT default fsScope to Lia root for generic coding goals', async () => {
    delete process.env.LIA_AGENT_SANDBOX_ONLY;
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;
    const r = await resolveAgentFsScope({ goal: 'изучи код и найди проблемы', explicitFsScope: null });
    expect(r.kind).toBe('sandbox');
    expect(isProjectRootFsScope(r.fsScope)).toBe(false);
    expect(isSandboxFsScope(r.fsScope)).toBe(true);
  });

  it('does not auto-mount Lia root for vague self-study phrasing', async () => {
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;
    const r = await resolveAgentFsScope({
      goal: 'Изучи себя досконально',
      explicitFsScope: null,
    });
    expect(r.kind).not.toBe('project');
    expect(isProjectRootFsScope(r.fsScope)).toBe(false);
  });

  it('mounts Lia root when goal names Lia', async () => {
    delete process.env.LIA_AGENT_MOUNT_SELF;
    const r = await resolveAgentFsScope({
      goal: 'Изучи проект Lia-v2-public, какие проблемы',
      explicitFsScope: null,
    });
    expect(r.kind).toBe('project');
    expect(resolve(r.fsScope!)).toBe(resolve(PATHS.root));
  });

  it('LIA_AGENT_MOUNT_SELF forces Lia root', async () => {
    process.env.LIA_AGENT_MOUNT_SELF = 'true';
    const r = await resolveAgentFsScope({ goal: 'изучи код', explicitFsScope: null });
    expect(r.kind).toBe('project');
    expect(isProjectRootFsScope(r.fsScope)).toBe(true);
  });

  it('respects explicit fsScope when path exists (resolved absolute)', async () => {
    const r = await resolveAgentFsScope({
      goal: 'изучи код',
      explicitFsScope: PATHS.root,
    });
    expect(r.kind).toBe('explicit');
    expect(resolve(r.fsScope!)).toBe(resolve(PATHS.root));
  });

  it('resolves relative explicit fsScope against cwd when it exists', async () => {
    const { relative, isAbsolute } = await import('path');
    const rel = relative(process.cwd(), PATHS.root);
    // Skip if PATHS.root is outside cwd (unusual in this repo’s test runs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;

    const r = await resolveAgentFsScope({
      goal: 'изучи код',
      explicitFsScope: rel,
    });
    expect(r.kind).toBe('explicit');
    expect(isAbsolute(r.fsScope!)).toBe(true);
    expect(resolve(r.fsScope!)).toBe(resolve(PATHS.root));
  });

  it('ignores explicit fsScope that does not exist (no silent broken scope)', async () => {
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;
    const missing = resolve(PATHS.root, `__missing_fs_scope_${Date.now()}__`);
    const r = await resolveAgentFsScope({
      goal: 'просто поговори', // not a coding goal → none after fallthrough
      explicitFsScope: missing,
    });
    expect(r.kind).not.toBe('explicit');
    expect(r.fsScope).toBeNull();
  });

  it('describeFsScope mentions workspace for project root', () => {
    const d = describeFsScopeForPrompt(PATHS.root);
    expect(d).toMatch(/list_tree/);
    expect(d).toMatch(/Lia|проект/i);
  });

  it('describeFsScope for external path does not assume Lia layout', () => {
    const d = describeFsScopeForPrompt('C:\\Users\\User\\Downloads\\AgentsRise');
    expect(d).toMatch(/внешний/i);
    expect(d).not.toMatch(/ARCHITECTURE|src\/lib\/agent/);
  });

  it('fallbackPlan uses web tools for news goals', () => {
    const plan = fallbackPlan(fakeTask('какие основные новости за сегодня?'));
    expect(plan.steps.some(s => /web_search/i.test(s))).toBe(true);
    expect(plan.steps.some(s => /fetch_page|ГОТОВО/i.test(s))).toBe(true);
  });

  it('fallbackPlan for SVO uses web path', () => {
    const plan = fallbackPlan(fakeTask('А что с СВО?'));
    expect(plan.steps[0]).toMatch(/web_search/i);
  });
});
