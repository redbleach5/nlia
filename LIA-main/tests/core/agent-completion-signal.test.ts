import { describe, expect, it } from 'vitest';
import {
  AGENT_COMPLETION_SIGNAL,
  hasAgentCompletionSignal,
  observationBlocksCompletion,
  shouldAcceptAgentCompletion,
} from '@/lib/agent/runner-helpers';

describe('agent completion signal (ГОТОВО)', () => {
  it('matches Cyrillic ГОТОВО at start of reply or line', () => {
    expect(AGENT_COMPLETION_SIGNAL.test('ГОТОВО: файл создан')).toBe(true);
    expect(AGENT_COMPLETION_SIGNAL.test('готово: план из 3 шагов')).toBe(true);
    expect(AGENT_COMPLETION_SIGNAL.test('Готово — всё сделано')).toBe(true);
    expect(AGENT_COMPLETION_SIGNAL.test('Мысль...\nГОТОВО: готово')).toBe(true);
  });

  it('matches English DONE at line start', () => {
    expect(AGENT_COMPLETION_SIGNAL.test('DONE: plan ready')).toBe(true);
    expect(hasAgentCompletionSignal('DONE: plan ready')).toBe(true);
  });

  it('does not match mid-sentence or COMPLETE/FINISHED', () => {
    expect(AGENT_COMPLETION_SIGNAL.test('Всё готово, продолжаю')).toBe(false);
    expect(AGENT_COMPLETION_SIGNAL.test('I am done with research')).toBe(false);
    expect(AGENT_COMPLETION_SIGNAL.test('COMPLETE: ok')).toBe(false);
    expect(AGENT_COMPLETION_SIGNAL.test('FINISHED: done')).toBe(false);
    expect(AGENT_COMPLETION_SIGNAL.test('перед ГОТОВО: не начало')).toBe(false);
  });

  it('blocks completion when last observation is empty/error', () => {
    expect(observationBlocksCompletion('{"tree":[]}')).toBe(true);
    expect(observationBlocksCompletion('{"error":"Путь выходит за пределы рабочей директории"}')).toBe(true);
    expect(hasAgentCompletionSignal('ГОТОВО: пусто', '{"tree":[]}')).toBe(false);
    expect(hasAgentCompletionSignal('ГОТОВО: ок', '{"chunks":[{"id":"1"}]}')).toBe(true);
  });

  it('rejects ГОТОВО for create goals without write_file', () => {
    expect(shouldAcceptAgentCompletion({
      goal: 'Напиши игру тетрис в неоновом стиле',
      text: 'ГОТОВО: вот код\n```html',
      lastObservation: 'ГОТОВО: вот код',
      stepsIncludingCurrent: [{ action: 'reason', observation: 'ГОТОВО: вот код' }],
    })).toBe(false);

    expect(shouldAcceptAgentCompletion({
      goal: 'Напиши игру тетрис в неоновом стиле',
      text: 'ГОТОВО: index.html записан',
      lastObservation: '{"ok":true,"path":"index.html"}',
      stepsIncludingCurrent: [
        { action: 'write_file', observation: '{"ok":true,"path":"index.html"}' },
      ],
    })).toBe(true);
  });
});
