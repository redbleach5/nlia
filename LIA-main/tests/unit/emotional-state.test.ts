import { describe, it, expect } from 'vitest';
import { createEmotionalStateSnapshot } from '@/lib/identity/emotional-state';
import type { EmotionVector } from '@/lib/personality';

function vec(partial: Partial<EmotionVector>): EmotionVector {
  return {
    joy: 0.5,
    curiosity: 0.5,
    calm: 0.5,
    irritation: 0.1,
    sadness: 0.1,
    ...partial,
  };
}

describe('createEmotionalStateSnapshot', () => {
  it('labels dominant emotion by max axis, not emotionToText heuristics', () => {
    // joy < 0.3 would make emotionToText say «грусть», but curiosity wins
    const snap = createEmotionalStateSnapshot(vec({
      joy: 0.2,
      curiosity: 0.85,
      calm: 0.4,
      sadness: 0.1,
    }));
    expect(snap.dominantEmotion).toBe('curiosity');
    expect(snap.intensityLabel).toBe('high');
    expect(snap.description).toMatch(/Доминирующая эмоция: любопытство/);
    expect(snap.description).not.toMatch(/Доминирующая эмоция: грусть/);
  });

  it('uses moderate intensity for mid-range dominant values', () => {
    const snap = createEmotionalStateSnapshot(vec({
      joy: 0.45,
      curiosity: 0.2,
      calm: 0.2,
    }));
    expect(snap.dominantEmotion).toBe('joy');
    expect(snap.intensityLabel).toBe('moderate');
    expect(snap.description).toMatch(/интенсивность: moderate/);
  });

  it('frames emotion as context, not an order', () => {
    const snap = createEmotionalStateSnapshot(vec({ irritation: 0.8, joy: 0.2 }));
    expect(snap.description).toMatch(/не приказ|не команда/i);
    expect(snap.description).not.toMatch(/помолчать|безмолвие/);
  });
});
