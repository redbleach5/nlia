import { describe, expect, it, vi, beforeEach } from 'vitest';

const findMany = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

describe('selectCodebaseSourcesForTask', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('scopes to codebase whose projectPath matches fsScope', async () => {
    findMany.mockResolvedValue([
      {
        id: 'lia',
        name: 'Lia',
        config: JSON.stringify({ projectPath: 'C:\\Users\\User\\Desktop\\Lia-v2-public' }),
      },
      {
        id: 'ar',
        name: 'AgentsRise',
        config: JSON.stringify({ projectPath: 'C:\\Users\\User\\Downloads\\AgentsRise' }),
      },
    ]);
    const { selectCodebaseSourcesForTask } = await import('@/lib/agent/tools/search-codebase');
    const got = await selectCodebaseSourcesForTask({
      goal: 'найди баги',
      fsScope: 'C:\\Users\\User\\Downloads\\AgentsRise',
    });
    expect(got).toEqual([{ id: 'ar', name: 'AgentsRise' }]);
  });

  it('scopes by goal source name', async () => {
    findMany.mockResolvedValue([
      { id: 'lia', name: 'Lia', config: '{}' },
      { id: 'ar', name: 'AgentsRise', config: '{}' },
    ]);
    const { selectCodebaseSourcesForTask } = await import('@/lib/agent/tools/search-codebase');
    const got = await selectCodebaseSourcesForTask({
      goal: 'Изучи AgentsRise',
      fsScope: null,
    });
    expect(got).toEqual([{ id: 'ar', name: 'AgentsRise' }]);
  });
});
