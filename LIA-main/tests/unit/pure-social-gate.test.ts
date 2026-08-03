import { describe, expect, it } from 'vitest';
import {
  detectTrivialMessageFlags,
  isPureSocialMessage,
  residualAfterSocialShell,
} from '@/lib/chat/message-heuristics';
import { classifyTaskComplexity } from '@/lib/task-complexity';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

/**
 * Contract: heuristics may cut budget; they must not inject an answer agenda
 * over residual (non-social) user content.
 */
describe('pure-social gate — contract', () => {
  const residualCases = [
    'Привет. Кто ты?',
    'Привет, помоги с TypeScript',
    'Как ты устроена?',
  ] as const;

  for (const msg of residualCases) {
    it(`residual in «${msg}» blocks trivial greeting/how-are-you flags`, () => {
      expect(residualAfterSocialShell(msg).length).toBeGreaterThan(0);
      expect(isPureSocialMessage(msg)).toBe(false);
      const flags = detectTrivialMessageFlags(msg);
      expect(flags.isTrivialGreeting).toBe(false);
      expect(flags.isTrivialHowAreYou).toBe(false);
    });

    it(`«${msg}» complexity is at least simple`, () => {
      expect(classifyTaskComplexity(msg)).not.toBe('trivial');
      expect(['simple', 'moderate', 'complex', 'research']).toContain(
        classifyTaskComplexity(msg),
      );
    });
  }

  it('pure Привет / Как дела? stay trivial', () => {
    expect(isPureSocialMessage('Привет!')).toBe(true);
    expect(detectTrivialMessageFlags('Привет!').isTrivialGreeting).toBe(true);
    expect(classifyTaskComplexity('Привет!')).toBe('trivial');

    expect(isPureSocialMessage('Как дела?')).toBe(true);
    expect(detectTrivialMessageFlags('Как дела?').isTrivialHowAreYou).toBe(true);
    expect(classifyTaskComplexity('Как дела?')).toBe('trivial');
  });

  it('non-trivial prompt has soft answer-first, not ask-name agenda', () => {
    const emotion = createInitialEmotion();
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      isTrivialGreeting: false,
      isTrivialHowAreYou: false,
      isAcquaintanceRequest: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(prompt).toContain('СОСТОЯНИЕ ДИАЛОГА');
    expect(prompt).toContain('скажи «я Лия»');
    expect(prompt).not.toContain('задай один вопрос — как зовут');
    expect(prompt).not.toContain('короткая реплика (привет / как дела)');
  });

  it('pure first hello may still ask for name', () => {
    const prompt = buildSystemPrompt({
      emotion: createInitialEmotion(),
      tier: 'standard',
      isTrivialGreeting: true,
      userNameKnown: false,
      episodeUserTurnCount: 1,
      episodeHasPriorGreeting: false,
    });
    expect(prompt).toContain('как зовут');
  });
});
