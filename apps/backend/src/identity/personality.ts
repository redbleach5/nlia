/**
 * Personality — Lia's temperament baseline + resting emotion.
 * Ported from v2 src/lib/personality.ts. Per § Appendix A: "port".
 */
import type { EmotionVector } from "./emotional-state.js";

export interface LiaPersonality {
  name: string;
  baselineEmotion: EmotionVector;
  baselineMaxDrift: number;
  baselineExperienceWeight: number;
}

export const LIA_PERSONALITY: LiaPersonality = {
  name: "Лия",
  baselineEmotion: { joy: 0.4, curiosity: 0.6, calm: 0.7, irritation: 0.1, sadness: 0.15 },
  baselineMaxDrift: 0.2,
  baselineExperienceWeight: 0.35,
};

export type EmotionAxis = keyof EmotionVector;
