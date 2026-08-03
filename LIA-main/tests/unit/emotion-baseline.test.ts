import { describe, expect, it } from 'vitest';
import {
  decayEmotion,
  resolveDecayBaseline,
  createInitialEmotion,
} from '@/lib/emotion';
import { LIA_PERSONALITY, type EmotionVector } from '@/lib/personality';

describe('resolveDecayBaseline', () => {
  it('returns personality copy when no recent emotions', () => {
    const base = resolveDecayBaseline([]);
    expect(base).toEqual(LIA_PERSONALITY.baselineEmotion);
    expect(base).not.toBe(LIA_PERSONALITY.baselineEmotion);
  });

  it('pulls resting point toward recent joy without leaving temperament band', () => {
    const highJoy: EmotionVector = {
      joy: 1,
      curiosity: 0.75,
      calm: 0.7,
      irritation: 0.1,
      sadness: 0.15,
    };
    const resting = resolveDecayBaseline([highJoy, highJoy, highJoy]);
    expect(resting.joy).toBeGreaterThan(LIA_PERSONALITY.baselineEmotion.joy);
    expect(resting.joy).toBeLessThanOrEqual(LIA_PERSONALITY.baselineEmotion.joy + 0.2);
  });
});

describe('decayEmotion with experience baseline', () => {
  it('decays toward custom resting point, not only personality', () => {
    const current: EmotionVector = {
      joy: 0.9,
      curiosity: 0.75,
      calm: 0.7,
      irritation: 0.1,
      sadness: 0.15,
    };
    const resting: EmotionVector = {
      ...createInitialEmotion(),
      joy: 0.7,
    };
    const after = decayEmotion(current, 60, resting);
    // After long idle, closer to resting.joy (0.7) than to personality (~0.55)
    expect(after.joy).toBeGreaterThan(0.65);
    expect(after.joy).toBeLessThan(0.85);
  });
});
