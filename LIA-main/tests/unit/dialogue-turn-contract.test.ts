import { describe, it, expect } from 'vitest';
import {
  deriveDialogueTurnContract,
  formatDialogueTurnContract,
} from '@/lib/chat/dialogue-turn-contract';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

describe('deriveDialogueTurnContract', () => {
  it('first pure hello: opening, mayGreet, askUserName', () => {
    const c = deriveDialogueTurnContract({
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(c).toMatchObject({
      phase: 'opening',
      mayGreet: true,
      turnKind: 'greeting',
      selfIntroRequired: false,
      askUserName: true,
    });
  });

  it('ongoing after prior greeting: mayGreet false', () => {
    const c = deriveDialogueTurnContract({
      isTrivialGreeting: false,
      episodeUserTurnCount: 3,
      episodeHasPriorGreeting: true,
    });
    expect(c.phase).toBe('ongoing');
    expect(c.mayGreet).toBe(false);
    expect(c.askUserName).toBe(false);
  });

  it('acquaintance sets selfIntroRequired', () => {
    const c = deriveDialogueTurnContract({
      isAcquaintanceRequest: true,
      episodeUserTurnCount: 2,
      episodeHasPriorGreeting: true,
    });
    expect(c.turnKind).toBe('acquaintance');
    expect(c.selfIntroRequired).toBe(true);
    expect(c.mayGreet).toBe(false);
  });

  it('acquaintance wins over trivial greeting flag', () => {
    const c = deriveDialogueTurnContract({
      isTrivialGreeting: true,
      isAcquaintanceRequest: true,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(c.turnKind).toBe('acquaintance');
    expect(c.selfIntroRequired).toBe(true);
    expect(c.askUserName).toBe(false);
  });

  it('how-are-you is social turnKind', () => {
    const c = deriveDialogueTurnContract({
      isTrivialHowAreYou: true,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(c.turnKind).toBe('social');
    expect(c.mayGreet).toBe(true);
  });
});

describe('formatDialogueTurnContract', () => {
  it('ongoing block forbids greeting open', () => {
    const text = formatDialogueTurnContract(
      deriveDialogueTurnContract({
        episodeUserTurnCount: 3,
        episodeHasPriorGreeting: true,
      }),
    );
    expect(text).toContain('СОСТОЯНИЕ ДИАЛОГА');
    expect(text).toContain('phase=ongoing; mayGreet=false');
    expect(text).toContain('без приветствия');
    expect(text).toContain('Имя: Лия');
  });

  it('acquaintance block anchors name and bans invented labels', () => {
    const text = formatDialogueTurnContract(
      deriveDialogueTurnContract({
        isAcquaintanceRequest: true,
        episodeUserTurnCount: 2,
        episodeHasPriorGreeting: true,
      }),
    );
    expect(text).toContain('скажи «я Лия»');
    expect(text).toContain('ИИ-собеседница');
    expect(text).not.toContain('как зовут');
  });
});

describe('system prompt — dialogue turn contract', () => {
  const emotion = createInitialEmotion();

  it('injects one state block; no hello-nag stack or toxic recentLia', () => {
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      episodeHasPriorGreeting: true,
      episodeUserTurnCount: 3,
      recentLiaMessages: '1. Привет! Как дела?',
    });
    expect(prompt).toContain('СОСТОЯНИЕ ДИАЛОГА');
    expect(prompt).toContain('mayGreet=false');
    expect(prompt).toContain('без приветствия');
    expect(prompt).not.toContain('ПРИВЕТСТВИЕ');
    expect(prompt).not.toContain('не открывай реплику приветствием');
    expect(prompt).not.toContain('не копируй');
    expect(prompt).not.toContain('ЗАПРЕТ:');
    expect(prompt).not.toContain('Снова:');
    expect(prompt).not.toContain('Привет! Как дела?');
    expect(prompt.match(/СОСТОЯНИЕ ДИАЛОГА/g)?.length).toBe(1);
  });

  it('acquaintance prompt names Lia, not ask-name agenda', () => {
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      isAcquaintanceRequest: true,
      userNameKnown: false,
      episodeUserTurnCount: 2,
      episodeHasPriorGreeting: true,
    });
    expect(prompt).toContain('скажи «я Лия»');
    expect(prompt).toContain('Не произноси «ИИ-собеседница»');
    expect(prompt).not.toContain('задай один вопрос — как зовут');
  });

  it('first hello without name asks for name via contract', () => {
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(prompt).toContain('как зовут');
    expect(prompt).toContain('mayGreet=true');
  });

  it('known name skips ask hint on trivial opening', () => {
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      isTrivialGreeting: true,
      userNameKnown: true,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(prompt).not.toContain('имя собеседника неизвестно');
    expect(prompt).not.toContain('задай один вопрос — как зовут');
    expect(prompt).toContain('Короткая реплика');
  });

  it('identity summary is Lia speech-first', () => {
    const prompt = buildSystemPrompt({ emotion, tier: 'standard' });
    expect(prompt.startsWith('Ты — Лия')).toBe(true);
    expect(prompt).not.toContain('ИИ-собеседница в приложении Lia');
  });
});
