import { describe, expect, it } from 'vitest';
import { PATHS } from '@/lib/paths';
import { buildCodeExplorationSeed } from '@/lib/agent/code-seed';

describe('buildCodeExplorationSeed', () => {
  it('returns empty for non-exploration goals', async () => {
    const seed = await buildCodeExplorationSeed('Скажи привет');
    expect(seed).toBe('');
  });

  it('injects ARCHITECTURE and key files for exploration on Lia root', async () => {
    const seed = await buildCodeExplorationSeed(
      'Изучи проект Lia-v2-public, какие в нем основные проблемы',
      PATHS.root,
    );
    expect(seed).toMatch(/ARCHITECTURE/);
    expect(seed).toMatch(/grep/);
    expect(seed).toMatch(/src\/lib\/agent\/runner\.ts/);
  });

  it('skips Lia seed for external fsScope (e.g. AgentsRise)', async () => {
    const seed = await buildCodeExplorationSeed(
      'Изучи репозиторий AgentsRise и исправь проблемы',
      'C:\\Users\\User\\Downloads\\AgentsRise',
    );
    expect(seed).toBe('');
  });

  it('skips Lia seed when fsScope is undefined/null', async () => {
    const goal = 'Изучи проект и найди проблемы';
    expect(await buildCodeExplorationSeed(goal)).toBe('');
    expect(await buildCodeExplorationSeed(goal, null)).toBe('');
  });
});
