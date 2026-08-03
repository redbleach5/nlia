import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  shouldRunInnerMonologue,
} from '@/lib/identity/inner-monologue';

describe('classifyIntent (companion cues)', () => {
  it('detects classic emotional markers', () => {
    expect(classifyIntent('Мне очень грустно сегодня')).toBe('emotional');
    expect(classifyIntent('Мне страшно и одиноко')).toBe('emotional');
  });

  it('detects relational / support phrasing', () => {
    expect(classifyIntent('Мне тяжело, просто поговори со мной')).toBe('emotional');
    expect(classifyIntent('Я скучаю по тебе')).toBe('emotional');
    expect(classifyIntent('Мне нужна поддержка')).toBe('emotional');
  });

  it('keeps tasks as instruction / learning', () => {
    expect(classifyIntent('Сделай рефакторинг pipeline.ts')).toBe('instruction');
    expect(classifyIntent('Как работает agent runner?')).toBe('learning');
  });

  it('classifies how-are-you as trivial, not learning', () => {
    expect(classifyIntent('как дела')).toBe('trivial');
    expect(classifyIntent('Как дела?')).toBe('trivial');
    expect(classifyIntent('привет')).toBe('trivial');
  });

  it('classifies thanks / jokes as trivial, not learning', () => {
    expect(classifyIntent('Спасибо 😁')).toBe('trivial');
    expect(classifyIntent('Расскажи мне шутку))')).toBe('trivial');
  });

  it('classifies talk-about-you as emotional, not learning', () => {
    expect(classifyIntent('Давай поговорим о тебе')).toBe('emotional');
  });

  it('does not default general chat to learning', () => {
    expect(classifyIntent('Муж на работе, снимаем вдвоём')).toBe('complex');
  });
});

describe('shouldRunInnerMonologue (latency pass — always off)', () => {
  const base = {
    isTrivialGreeting: false,
    isTrivialHowAreYou: false,
    isAgent: false,
    emotionTriggers: [] as string[],
  };

  it('never runs — micro', () => {
    expect(shouldRunInnerMonologue({
      ...base, tier: 'micro', intent: 'emotional',
    })).toBe(false);
  });

  it('never runs — plus/max emotional', () => {
    expect(shouldRunInnerMonologue({
      ...base, tier: 'plus', intent: 'emotional',
    })).toBe(false);
    expect(shouldRunInnerMonologue({
      ...base, tier: 'max', intent: 'instruction',
    })).toBe(false);
  });

  it('never runs — acquaintance / affective triggers', () => {
    expect(shouldRunInnerMonologue({
      ...base, tier: 'standard', intent: 'learning', isAcquaintanceRequest: true,
    })).toBe(false);
    expect(shouldRunInnerMonologue({
      ...base, tier: 'standard', intent: 'learning', emotionTriggers: ['sadTopic'],
    })).toBe(false);
  });
});
