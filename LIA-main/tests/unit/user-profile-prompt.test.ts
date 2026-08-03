import { describe, it, expect } from 'vitest';
import {
  detectTrivialMessageFlags,
  detectAcquaintanceRequest,
  episodeHasPriorGreeting,
  resolveAcquaintanceContext,
} from '@/lib/chat/message-heuristics';
import { MAX_MESSAGES_TO_CONSIDER } from '@/lib/chat/context-budget';

describe('message heuristics — acquaintance', () => {
  it('treats «давай знакомиться» as acquaintance, not trivial greeting', () => {
    const flags = detectTrivialMessageFlags('Привет. Давай знакомиться');
    expect(flags.isAcquaintanceRequest).toBe(true);
    expect(flags.isTrivialGreeting).toBe(false);
  });

  it('plain привет stays trivial greeting', () => {
    const flags = detectTrivialMessageFlags('Привет!');
    expect(flags.isTrivialGreeting).toBe(true);
    expect(flags.isAcquaintanceRequest).toBe(false);
  });

  it('detectAcquaintanceRequest matches представься', () => {
    expect(detectAcquaintanceRequest('Давай представимся')).toBe(true);
  });

  it('episodeHasPriorGreeting sees earlier hello', () => {
    expect(episodeHasPriorGreeting([
      { role: 'user', content: 'Привет' },
      { role: 'companion', content: 'Привет!' },
    ])).toBe(true);
  });

  it('greeting plus task is not trivial greeting', () => {
    const flags = detectTrivialMessageFlags('Привет, помоги с TypeScript');
    expect(flags.isTrivialGreeting).toBe(false);
    expect(flags.isTrivialHowAreYou).toBe(false);
  });
});

describe('resolveAcquaintanceContext — long episodes', () => {
  it('dialogue fetch cap matches budget max', () => {
    expect(MAX_MESSAGES_TO_CONSIDER).toBe(50);
  });

  it('first turn: ask-name window', () => {
    const ctx = resolveAcquaintanceContext({
      recentMessages: [],
      storedMessageCountBeforeTurn: 0,
    });
    expect(ctx.episodeUserTurnCount).toBe(1);
    expect(ctx.episodeHasPriorGreeting).toBe(false);
  });

  it('does not treat turn ~150 as first hello when window is truncated', () => {
    const ctx = resolveAcquaintanceContext({
      recentMessages: [
        { role: 'user', content: 'ок' },
        { role: 'companion', content: 'поняла' },
        { role: 'user', content: 'продолжим' },
        { role: 'companion', content: 'да' },
      ],
      storedMessageCountBeforeTurn: 298,
    });
    expect(ctx.episodeUserTurnCount).toBeGreaterThan(4);
    expect(ctx.episodeHasPriorGreeting).toBe(true);
  });
});
