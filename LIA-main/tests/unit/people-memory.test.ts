import { describe, it, expect } from 'vitest';
import {
  resolvePersonFromUtterance,
  extractClaimedNameFromUtterance,
  formatPersonProfileForPrompt,
  MAX_PEOPLE,
  type PersonRecord,
} from '@/lib/memory/people';
import { deriveDialogueTurnContract, formatDialogueTurnContract } from '@/lib/chat/dialogue-turn-contract';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

const mashа: PersonRecord = {
  id: 'p1',
  displayName: 'Маша',
  aliases: ['Мария'],
  isDefault: true,
  lastSeenAt: null,
};

const petya: PersonRecord = {
  id: 'p2',
  displayName: 'Петя',
  aliases: [],
  isDefault: false,
  lastSeenAt: null,
};

describe('resolvePersonFromUtterance', () => {
  it('matches explicit «я Маша»', () => {
    expect(resolvePersonFromUtterance('Привет, я Маша', [mashа, petya])?.id).toBe('p1');
  });

  it('matches alias', () => {
    expect(resolvePersonFromUtterance('Меня зовут Мария', [mashа, petya])?.id).toBe('p1');
  });

  it('matches bare name mention', () => {
    expect(resolvePersonFromUtterance('Петя тут', [mashа, petya])?.id).toBe('p2');
  });

  it('returns null when ambiguous or unknown', () => {
    expect(resolvePersonFromUtterance('Привет', [mashа, petya])).toBeNull();
    expect(resolvePersonFromUtterance('я Вася', [mashа, petya])).toBeNull();
  });

  it('extractClaimedNameFromUtterance picks intro name', () => {
    expect(extractClaimedNameFromUtterance('Меня зовут Вася')).toBe('Вася');
  });
});

describe('formatPersonProfileForPrompt', () => {
  it('includes only that person', () => {
    const text = formatPersonProfileForPrompt(mashа, [
      { key: 'profession', value: 'дизайнер', confidence: 0.8 },
    ]);
    expect(text).toContain('Маша');
    expect(text).toContain('profession');
    expect(text).not.toContain('Петя');
  });
});

describe('dialogue contract — multi-person identify', () => {
  it('needIdentifySpeaker when unbound multi; not askUserName', () => {
    const c = deriveDialogueTurnContract({
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
      needIdentifySpeaker: true,
      knownPeopleNames: ['Маша', 'Петя'],
    });
    expect(c.needIdentifySpeaker).toBe(true);
    expect(c.askUserName).toBe(false);
    const formatted = formatDialogueTurnContract(c);
    expect(formatted).toContain('Маша');
    expect(formatted).toContain('Петя');
    expect(formatted).toContain('кто сейчас пишет');
    expect(formatted).not.toContain('как зовут');
  });

  it('askUserName only with zero people path (no identify)', () => {
    const c = deriveDialogueTurnContract({
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
      needIdentifySpeaker: false,
      knownPeopleNames: [],
    });
    expect(c.askUserName).toBe(true);
    expect(c.needIdentifySpeaker).toBe(false);
  });

  it('prompt injects identify block, not all profiles as current speaker', () => {
    const prompt = buildSystemPrompt({
      emotion: createInitialEmotion(),
      tier: 'standard',
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
      needIdentifySpeaker: true,
      knownPeopleNames: ['Маша', 'Петя'],
      userProfile: undefined,
    });
    expect(prompt).toContain('Известные люди: Маша, Петя');
    expect(prompt).not.toContain('Собеседник:\n  name: Маша');
    expect(MAX_PEOPLE).toBe(3);
  });

  it('bound person profile is injected alone', () => {
    const prompt = buildSystemPrompt({
      emotion: createInitialEmotion(),
      tier: 'standard',
      userNameKnown: true,
      episodeUserTurnCount: 2,
      episodeHasPriorGreeting: true,
      userProfile: formatPersonProfileForPrompt(mashа, [
        { key: 'profession', value: 'дизайнер', confidence: 0.9 },
      ]),
    });
    expect(prompt).toContain('Собеседник:');
    expect(prompt).toContain('Маша');
    expect(prompt).toContain('дизайнер');
    expect(prompt).not.toContain('кто сейчас пишет');
  });
});
