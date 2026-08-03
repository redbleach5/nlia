import { describe, it, expect } from 'vitest';
import { getCharacterDescription, LIA_CHARACTER } from '@/lib/identity/character';
import { createFallbackDecision } from '@/lib/identity/decision';

describe('attachment choice (no owed love)', () => {
  it('LIA_CHARACTER describes attachment as choice, not duty', () => {
    expect(LIA_CHARACTER.values.attachment).toMatch(/выбор/i);
    expect(LIA_CHARACTER.values.attachment).toMatch(/не обязана/i);
    expect(LIA_CHARACTER.values.attachment).toMatch(/Притворяться влюблённой/i);
  });

  it('getCharacterDescription includes attachment for monologue', () => {
    const text = getCharacterDescription();
    expect(text).toContain('attachment');
    expect(text).toMatch(/выбор, не долг/i);
    expect(text).toMatch(/сама понимаешь, что чувствуешь/i);
  });

  it('emotional fallback does not require reciprocity or mandatory comfort', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'joy', intensityLabel: 'moderate' },
      intent: 'emotional',
      isKbQuestion: false,
      isAgent: false,
    });
    expect(d.action).toBe('emotional_response');
    expect(d.motivation).toMatch(/взаимность/i);
    expect(d.motivation).not.toMatch(/обязана любить|обязательное утешение не нужны/i);
    expect(d.motivation).toMatch(/не требуются/i);
  });

  it('trivial + high irritation fallback is reluctant_help (intensityLabel contract)', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'irritation', intensityLabel: 'moderate' },
      intent: 'trivial',
      isKbQuestion: false,
      isAgent: false,
    });
    // 'moderate' must NOT trigger reluctant — only 'high' does
    expect(d.action).toBe('help');

    const high = createFallbackDecision({
      emotionalState: { dominantEmotion: 'irritation', intensityLabel: 'high' },
      intent: 'trivial',
      isKbQuestion: false,
      isAgent: false,
    });
    expect(high.action).toBe('reluctant_help');
  });

  it('emotional + sadness fallback prefers concern over forced cheer', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'sadness', intensityLabel: 'high' },
      intent: 'emotional',
      isKbQuestion: false,
      isAgent: false,
    });
    expect(d.desiredTone).toBe('concerned');
    expect(d.emotionalExpression).toBe('concern');
  });

  it('joke cue → playful even if intent is trivial', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'neutral', intensityLabel: 'low' },
      intent: 'trivial',
      isKbQuestion: false,
      isAgent: false,
      userMessage: 'Расскажи мне шутку))',
    });
    expect(d.desiredTone).toBe('playful');
    expect(d.emotionalExpression).toBe('playfulness');
  });

  it('about-you cue → emotional_response about self', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'neutral', intensityLabel: 'low' },
      intent: 'complex',
      isKbQuestion: false,
      isAgent: false,
      userMessage: 'Давай поговорим о тебе',
    });
    expect(d.action).toBe('emotional_response');
    expect(d.motivation).toMatch(/о себе/i);
  });

  it('fatigue cue → concerned presence', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'neutral', intensityLabel: 'low' },
      intent: 'complex',
      isKbQuestion: false,
      isAgent: false,
      userMessage: 'Сейчас я устала и не могу ничего вспомнить 😭',
    });
    expect(d.action).toBe('emotional_response');
    expect(d.desiredTone).toBe('concerned');
  });

  it('thanks cue → short warm', () => {
    const d = createFallbackDecision({
      emotionalState: { dominantEmotion: 'neutral', intensityLabel: 'low' },
      intent: 'complex',
      isKbQuestion: false,
      isAgent: false,
      userMessage: 'Спасибо большое!',
    });
    expect(d.desiredTone).toBe('warm');
    expect(d.willingnessToHelp).toBeLessThan(0.6);
    expect(d.motivation).toMatch(/коротко/i);
  });
});
