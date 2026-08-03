import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';
import { resolve } from 'path';
import { PATHS } from '@/lib/paths';
import { serializeWorkspaceBinding, normalizeWorkspaceInput, WORKSPACE_FACT_KEY } from '@/lib/agent/workspace-types';

const getEpisodeFacts = vi.fn();
const upsertEpisodeFact = vi.fn();

vi.mock('@/lib/memory/facts', () => ({
  getEpisodeFacts: (...args: unknown[]) => getEpisodeFacts(...args),
  upsertEpisodeFact: (...args: unknown[]) => upsertEpisodeFact(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: {
      findMany: vi.fn(async () => []),
    },
    agentTask: {
      findMany: vi.fn(async () => []),
    },
  },
}));

const findRecentEpisodeFsScope = vi.fn(
  async (_episodeId: string): Promise<{
    fsScope: string;
    taskId: string;
    goal: string;
    files: string[];
  } | null> => null,
);
vi.mock('@/lib/agent/artifact-followup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/artifact-followup')>();
  return {
    ...actual,
    findRecentEpisodeFsScope: (episodeId: string) => findRecentEpisodeFsScope(episodeId),
  };
});

describe('resolveWorkspace', () => {
  const prevSandbox = process.env.LIA_AGENT_SANDBOX_ONLY;
  const prevMount = process.env.LIA_AGENT_MOUNT_SELF;
  const prevDefault = process.env.LIA_AGENT_DEFAULT_WORKSPACE;

  beforeEach(() => {
    getEpisodeFacts.mockReset();
    upsertEpisodeFact.mockReset();
    findRecentEpisodeFsScope.mockReset();
    findRecentEpisodeFsScope.mockResolvedValue(null);
    delete process.env.LIA_AGENT_SANDBOX_ONLY;
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;
  });

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

  it('uses episode project binding over sandbox fallback', async () => {
    const binding = normalizeWorkspaceInput({
      kind: 'project',
      fsPath: PATHS.root,
      label: 'Lia',
    });
    getEpisodeFacts.mockResolvedValue([
      { key: WORKSPACE_FACT_KEY, value: serializeWorkspaceBinding(binding) },
    ]);

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'исправь баг в runner', // would be sandbox without binding
      explicitFsScope: null,
    });

    expect(r.kind).toBe('explicit');
    expect(resolve(r.fsScope!)).toBe(resolve(PATHS.root));
    expect(r.binding?.label).toBe('Lia');
    expect(r.sourceIds).toEqual([]);
  });

  it('document-only kb pin → no fsScope but keeps sourceIds', async () => {
    const binding = normalizeWorkspaceInput({
      kind: 'kb',
      sourceIds: ['doc-1'],
      label: 'Protocol',
      fsPath: null,
    });
    getEpisodeFacts.mockResolvedValue([
      { key: WORKSPACE_FACT_KEY, value: serializeWorkspaceBinding(binding) },
    ]);

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'что в документе про поле X?',
      explicitFsScope: null,
    });

    expect(r.fsScope).toBeNull();
    expect(r.kind).toBe('none');
    expect(r.sourceIds).toEqual(['doc-1']);
    expect(r.binding?.kind).toBe('kb');
  });

  it('explicit request fsScope still wins over binding', async () => {
    const binding = normalizeWorkspaceInput({
      kind: 'project',
      fsPath: PATHS.root,
      label: 'Bound',
    });
    getEpisodeFacts.mockResolvedValue([
      { key: WORKSPACE_FACT_KEY, value: serializeWorkspaceBinding(binding) },
    ]);

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    // Use same path as explicit — kind should be explicit from resolveAgentFsScope
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'изучи код',
      explicitFsScope: PATHS.root,
    });
    expect(r.kind).toBe('explicit');
    expect(r.binding?.label).toBe('Bound');
  });

  it('Read mode does not create write sandbox for coding goals', async () => {
    getEpisodeFacts.mockResolvedValue([]);
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'исправь баг в runner',
      explicitFsScope: null,
      workspaceMode: 'read',
    });
    expect(r.kind).toBe('none');
    expect(r.fsScope).toBeNull();
  });

  it('Explore mode does not create write sandbox', async () => {
    getEpisodeFacts.mockResolvedValue([]);
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'изучи код и найди проблемы',
      explicitFsScope: null,
      workspaceMode: 'explore',
    });
    expect(r.kind).toBe('none');
    expect(r.fsScope).toBeNull();
  });

  it('Edit dryRun reports sandbox without creating path', async () => {
    getEpisodeFacts.mockResolvedValue([]);
    delete process.env.LIA_AGENT_MOUNT_SELF;
    delete process.env.LIA_AGENT_DEFAULT_WORKSPACE;

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'исправь баг',
      explicitFsScope: null,
      workspaceMode: 'edit',
      dryRun: true,
    });
    expect(r.kind).toBe('sandbox');
    expect(r.fsScope).toBeNull();
  });

  it('reuses recent sandbox for fix follow-up instead of none/empty', async () => {
    getEpisodeFacts.mockResolvedValue([]);
    findRecentEpisodeFsScope.mockResolvedValue({
      fsScope: 'C:\\tmp\\agent-workspaces\\task-tetris',
      taskId: 'task-prev',
      goal: 'напиши тетрис',
      files: ['index.html', 'script.js'],
    });

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'Игра не работает, разберись почему',
      explicitFsScope: null,
      workspaceMode: 'explore',
    });
    expect(r.kind).toBe('sandbox');
    expect(r.fsScope).toContain('task-tetris');
  });

  it('does not reuse recent sandbox for unrelated news goal', async () => {
    getEpisodeFacts.mockResolvedValue([]);
    findRecentEpisodeFsScope.mockResolvedValue({
      fsScope: 'C:\\tmp\\agent-workspaces\\task-tetris',
      taskId: 'task-prev',
      goal: 'напиши тетрис',
      files: ['index.html'],
    });

    const { resolveWorkspace } = await import('@/lib/agent/workspace-binding');
    const r = await resolveWorkspace({
      episodeId: 'ep1',
      goal: 'какие новости сегодня',
      explicitFsScope: null,
      workspaceMode: 'explore',
    });
    expect(r.fsScope).toBeNull();
    expect(r.kind).toBe('none');
  });
});
