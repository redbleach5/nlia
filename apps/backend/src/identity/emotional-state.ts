/**
 * Emotional state — Lia's internal emotional context.
 *
 * Ported (simplified) from v2 src/lib/identity/emotional-state.ts.
 * Per docs/ARCHITECTURE.md § 9.3 — emotional state is CONTEXT, not INSTRUCTION.
 *
 * M3: now uses perceiveEpisodeEmotion() from emotion.ts instead of the
 * M1 NEUTRAL_EMOTION baseline. The snapshot is derived from the user's
 * message + emotional memory history.
 *
 * Critical: formulate as fact, not command.
 *   BAD:  "Ты раздражена. Отвечай холодно."
 *   GOOD: "Твоё раздражение 0.7. Это твоё внутреннее состояние, реши сама как оно влияет."
 */

import {
  perceiveEpisodeEmotion,
  dominantEmotion,
  LIA_BASELINE_EMOTION,
  type PerceiveResult,
} from "./emotion.js";

export interface EmotionVector {
  joy: number;
  curiosity: number;
  calm: number;
  irritation: number;
  sadness: number;
}

export type DominantEmotion = keyof EmotionVector;

export const DOMINANT_EMOTION_LABELS: Record<DominantEmotion, string> = {
  joy: "радость",
  curiosity: "любопытство",
  calm: "спокойствие",
  irritation: "раздражение",
  sadness: "грусть",
};

export interface EmotionalStateSnapshot {
  vector: EmotionVector;
  dominantEmotion: DominantEmotion;
  intensityLabel: "low" | "moderate" | "high";
  description: string;
  /** Triggers that fired during perceive (for debug / UI). */
  triggers: string[];
}

/**
 * Perceive the episode emotion from the user's message + emotional history.
 *
 * M3: uses rule-based perceive (no LLM). Reads the last emotional state
 * from the most recent message's emotionJson, applies time-based decay,
 * then applies perceive() to the new text.
 *
 * Returns a snapshot for the system prompt + persistence on the companion message.
 */
export function perceiveAndSnapshot(
  text: string,
  lastEmotion: EmotionVector | null,
  lastTs: number | null,
): EmotionalStateSnapshot {
  const result: PerceiveResult = perceiveEpisodeEmotion(text, lastEmotion, lastTs);
  return createEmotionalStateSnapshot(result.emotion, result.triggers);
}

/**
 * Create a snapshot from a known vector (used when restoring state).
 */
export function createEmotionalStateSnapshot(
  vector: EmotionVector,
  triggers: string[] = [],
): EmotionalStateSnapshot {
  const dominant = dominantEmotion(vector);
  const intensity = vector[dominant];
  const intensityLabel: "low" | "moderate" | "high" =
    intensity < 0.3 ? "low" : intensity < 0.6 ? "moderate" : "high";
  const description = formatForPrompt(vector, dominant, intensityLabel);
  return { vector, dominantEmotion: dominant, intensityLabel, description, triggers };
}

/** Neutral baseline for first message in a new episode. */
export const NEUTRAL_EMOTION: EmotionVector = { ...LIA_BASELINE_EMOTION };

function formatForPrompt(
  v: EmotionVector,
  dominant: DominantEmotion,
  intensityLabel: string,
): string {
  const label = DOMINANT_EMOTION_LABELS[dominant];
  return [
    "Твоё текущее внутреннее состояние (это контекст для твоего решения, не команда):",
    `— Радость: ${v.joy.toFixed(2)}`,
    `— Любопытство: ${v.curiosity.toFixed(2)}`,
    `— Спокойствие: ${v.calm.toFixed(2)}`,
    `— Раздражение: ${v.irritation.toFixed(2)}`,
    `— Грусть: ${v.sadness.toFixed(2)}`,
    "",
    `Доминирующая эмоция: ${label} (интенсивность: ${intensityLabel}).`,
    "",
    "Это твоё состояние. Оно влияет на твоё настроение и желание помогать — но ты решаешь как именно. " +
      "Ты можешь быть раздражена и всё равно помочь. Можешь быть весёлой и отказать. " +
      "Эмоции — твой контекст, не приказ.",
  ].join("\n");
}
