import { describe, it, expect } from 'vitest';
import { deriveDialogueTurnContract } from '@/lib/chat/dialogue-turn-contract';
import { detectTrivialMessageFlags, resolveAcquaintanceContext } from '@/lib/chat/message-heuristics';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

/**
 * Replay of the bad chat scenario — asserts prompt contract quality,
 * not model generation (no Ollama call).
 */
describe('dialogue contract — bad-chat scenario replay', () => {
  it('fixes prompt defects that caused hello-loop and человек-модель', () => {
    const turns = [
      'Привет',
      'Кто ты?',
      'Хороший вопрос',
      'Почему ты все время здороваешься?',
      'хочу проверить перестала ли ты здороваться',
      'кто ты?',
      'Я думал ты Лия',
    ];

    type Hist = { role: string; content: string };
    const history: Hist[] = [];
    const emotion = createInitialEmotion();
    const report: Array<Record<string, unknown>> = [];

    for (const text of turns) {
      const flags = detectTrivialMessageFlags(text);
      const acq = resolveAcquaintanceContext({
        recentMessages: history,
        storedMessageCountBeforeTurn: history.length,
      });
      const contract = deriveDialogueTurnContract({
        ...flags,
        userNameKnown: false,
        episodeUserTurnCount: acq.episodeUserTurnCount,
        episodeHasPriorGreeting: acq.episodeHasPriorGreeting,
      });
      const poison = history
        .filter((m) => m.role === 'companion')
        .slice(-4)
        .map((m, i) => `${i + 1}. ${m.content.slice(0, 120)}`)
        .join('\n');

      const prompt = buildSystemPrompt({
        emotion,
        tier: 'standard',
        ...flags,
        userNameKnown: false,
        episodeUserTurnCount: acq.episodeUserTurnCount,
        episodeHasPriorGreeting: acq.episodeHasPriorGreeting,
        dialogueContract: contract,
        recentLiaMessages: poison || undefined,
      });

      const leftoverNags = [
        'ЗАПРЕТ:',
        'Снова:',
        'не копируй',
        'ПРИВЕТСТВИЕ:',
        'Твои последние сообщения',
      ].filter((s) => prompt.includes(s));

      report.push({
        user: text,
        phase: contract.phase,
        mayGreet: contract.mayGreet,
        turnKind: contract.turnKind,
        selfIntro: contract.selfIntroRequired,
      });

      expect(prompt.match(/СОСТОЯНИЕ ДИАЛОГА/g)?.length).toBe(1);
      expect(leftoverNags).toEqual([]);
      expect(prompt).toContain('Ты — Лия');
      expect(prompt).not.toContain('ИИ-собеседница в приложении');
      // Old toxic few-shot must not appear (ban phrase «человек-модель» in contract is OK).
      expect(prompt).not.toContain('Привет! Чем могу быть полезна?');
      expect(prompt).not.toContain('Привет! Я — человек-модель');

      if (text === 'Привет') {
        expect(contract.mayGreet).toBe(true);
        expect(contract.phase).toBe('opening');
      } else {
        expect(contract.mayGreet).toBe(false);
        expect(prompt).toContain('без приветствия');
      }

      if (/кто ты/i.test(text)) {
        expect(contract.selfIntroRequired).toBe(true);
        expect(prompt).toContain('скажи «я Лия»');
        expect(prompt).toContain('Не произноси «ИИ-собеседница»');
      }

      const fakeLia = contract.mayGreet
        ? 'Привет! Чем могу быть полезна?'
        : contract.selfIntroRequired
          ? 'Привет! Я — человек-модель...'
          : 'ок';
      history.push({ role: 'user', content: text });
      history.push({ role: 'companion', content: fakeLia });
    }

    // After first turn, every remaining turn must forbid greeting.
    expect(report.slice(1).every((r) => r.mayGreet === false)).toBe(true);
    // Both «кто ты» turns require self-intro.
    expect(report.filter((r) => r.selfIntro === true)).toHaveLength(2);

    // eslint-disable-next-line no-console
    console.log('scenario-report', JSON.stringify(report, null, 2));
  });
});
