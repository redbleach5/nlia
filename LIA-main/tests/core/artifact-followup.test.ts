import { describe, expect, it } from 'vitest';
import {
  isOpenOrShowArtifactGoal,
  isReferentialWorkspaceGoal,
  isFixOrDebugArtifactGoal,
  shouldReuseRecentEpisodeSandbox,
} from '@/lib/agent/artifact-followup-client';

describe('artifact follow-up intents', () => {
  it('detects open/show game follow-ups', () => {
    expect(isOpenOrShowArtifactGoal('Можешь открыть эту игру?')).toBe(true);
    expect(isOpenOrShowArtifactGoal('открой index.html')).toBe(true);
    expect(isOpenOrShowArtifactGoal('запусти игру')).toBe(true);
    expect(isOpenOrShowArtifactGoal('Напиши игру тетрис')).toBe(false);
    expect(isOpenOrShowArtifactGoal('Изучи проект')).toBe(false);
  });

  it('detects fix/debug follow-ups about the game', () => {
    expect(isFixOrDebugArtifactGoal('Игра не работает, разберись почему')).toBe(true);
    expect(isFixOrDebugArtifactGoal('почини тетрис')).toBe(true);
    expect(isFixOrDebugArtifactGoal('Напиши игру тетрис')).toBe(false);
  });

  it('detects referential workspace goals', () => {
    expect(isReferentialWorkspaceGoal('эту игру можно улучшить?')).toBe(true);
    expect(isReferentialWorkspaceGoal('Игра не работает, разберись почему')).toBe(true);
    expect(isReferentialWorkspaceGoal('какие новости сегодня')).toBe(false);
  });

  it('reuses sandbox for fix/improve, not for news or fresh create', () => {
    expect(shouldReuseRecentEpisodeSandbox('Игра не работает, разберись почему')).toBe(true);
    expect(shouldReuseRecentEpisodeSandbox('улучши UI')).toBe(true);
    expect(shouldReuseRecentEpisodeSandbox('добавь счётчик очков')).toBe(true);
    expect(shouldReuseRecentEpisodeSandbox('Напиши игру тетрис')).toBe(false);
    expect(shouldReuseRecentEpisodeSandbox('какие новости сегодня')).toBe(false);
  });
});
