/**
 * Emotion — 5-axis model with rule-based perceive + exponential decay.
 *
 * Ported from v2 src/lib/emotion.ts. Per docs/ARCHITECTURE.md § 9.3 —
 * emotional state is CONTEXT for the model, not an INSTRUCTION.
 *
 * Rule-based perceive (no LLM classification) — fixes v1 bug where LLM
 * classify often mislabelled messages ("купи молоко" → rudeness) and
 * polluted the emotional state.
 *
 * 5 axes: joy, curiosity, calm, irritation, sadness — all 0..1.
 * Resting baseline = personality temperament. Decay pulls toward baseline.
 */

import type { EmotionVector, DominantEmotion } from "./emotional-state.js";
import { LIA_PERSONALITY } from "./personality.js";

// ─── Personality baseline (Lia's temperament) ────────────────────────
// Re-exported from personality.ts so emotion axes and personality name
// live in one place (per docs/ARCHITECTURE.md § 9.3 baseline definition).
export const LIA_BASELINE_EMOTION: EmotionVector = LIA_PERSONALITY.baselineEmotion;


// ─── Perceive triggers (rule-based, Cyrillic-safe regex) ─────────────
type Trigger =
  | "warmth"
  | "rudeness"
  | "sadTopic"
  | "enthusiasm"
  | "curiosity"
  | "deepQuestion"
  | "disagreement"
  | "task"
  | "trivial";

const TRIGGERS: Array<{ name: Trigger; regex: RegExp; weight: number }> = [
  // Rudeness — only real insults
  {
    name: "rudeness",
    regex: /(?:^|[^a-zа-яё0-9_])(иди|отстань|заткнис|дурак|тупой|раздражаешь|бесишь|чушь|бред|хрень|идиот|придурок|урод|сволочь|нахуй|пизд|ебан|сука)(?![a-zа-яё0-9_])/iu,
    weight: 0.9,
  },
  // Sad topics
  {
    name: "sadTopic",
    regex: /(умер|погиб|похорон|боле|рак|депресс|одинок|бросил|бросила|развод|умира|тяжело|не могу больше|устал жить)/i,
    weight: 0.8,
  },
  // Enthusiasm
  {
    name: "enthusiasm",
    regex: /(обожаю|получилось|ура|класс|супер|потрясающе|вау|шикарно|обалденно)/i,
    weight: 0.85,
  },
  // Curiosity
  {
    name: "curiosity",
    regex: /(почему|как устроен|как работает|откуда|зачем нужно|что будет если)/i,
    weight: 0.7,
  },
  // Deep questions
  {
    name: "deepQuestion",
    regex: /(в чём смысл|что такое.*на самом деле|существует ли|свобода воли|сознани|бессмерти|душа|бог|смерть|добро и зло)/i,
    weight: 0.85,
  },
  // Warmth
  {
    name: "warmth",
    regex: /(спасибо|благодар|доброе утро|добрый день|добрый вечер|привет|скучал|рад видеть|люблю тебя)/i,
    weight: 0.6,
  },
  // Disagreement
  {
    name: "disagreement",
    regex: /(не согласен|не согласна|ты неправ|ошибаешься|это не так|не верю|ерунда это)/i,
    weight: 0.65,
  },
  // Task — Lia likes to help
  {
    name: "task",
    regex: /(найди|поиск|загугли|создай|напиши|сделай|нарисуй|сгенерируй|проанализируй|проверь|обнови|исправь|оптимизируй|рефактор)/i,
    weight: 0.75,
  },
  // Trivial questions
  {
    name: "trivial",
    regex: /^(привет|как дела|что делаешь|как ты|приветик)\??\.?$/i,
    weight: 0.4,
  },
];

const EMOTION_DELTAS: Record<Trigger, Partial<EmotionVector>> = {
  warmth: { joy: +0.2, calm: +0.15, irritation: -0.15, sadness: -0.1 },
  rudeness: { irritation: +0.3, joy: -0.2, calm: -0.2, sadness: +0.1 },
  sadTopic: { sadness: +0.3, joy: -0.2, calm: -0.1, curiosity: +0.05 },
  enthusiasm: { joy: +0.25, curiosity: +0.1, calm: -0.05 },
  curiosity: { curiosity: +0.2, joy: +0.05 },
  deepQuestion: { curiosity: +0.25, joy: +0.1, irritation: -0.1 },
  disagreement: { curiosity: +0.15, irritation: +0.05, calm: -0.05 },
  task: { curiosity: +0.15, joy: +0.05 },
  trivial: { curiosity: -0.05, irritation: +0.02 },
};

export interface PerceiveResult {
  emotion: EmotionVector;
  triggers: Trigger[];
}

/**
 * Rule-based perceive: what stimulus does the user message create?
 * NOT "what Lia decided she feels" — that's the model's job.
 * Returns a new emotion vector (does not mutate input).
 */
export function perceive(text: string, current: EmotionVector): PerceiveResult {
  const emotion = { ...current };
  const triggers: Trigger[] = [];

  for (const { name, regex, weight } of TRIGGERS) {
    if (regex.test(text)) {
      triggers.push(name);
      const delta = EMOTION_DELTAS[name];
      for (const axis in delta) {
        const a = axis as keyof EmotionVector;
        emotion[a] = clamp(emotion[a] + (delta[a] ?? 0) * weight);
      }
    }
  }

  return { emotion, triggers };
}

// ─── Decay — exponential toward baseline per minute ──────────────────
const DECAY_PER_MIN = 0.02;

export function decayEmotion(
  current: EmotionVector,
  dtMinutes: number,
  baseline: EmotionVector = LIA_BASELINE_EMOTION,
): EmotionVector {
  const factor = Math.exp(-DECAY_PER_MIN * dtMinutes);
  return {
    joy: blendToward(current.joy, baseline.joy, factor),
    curiosity: blendToward(current.curiosity, baseline.curiosity, factor),
    calm: blendToward(current.calm, baseline.calm, factor),
    irritation: blendToward(current.irritation, baseline.irritation, factor),
    sadness: blendToward(current.sadness, baseline.sadness, factor),
  };
}

/**
 * Perceive emotion for the current episode.
 *
 * M3: loads the last emotional state from the most recent message's emotionJson,
 * applies decay based on time elapsed, then applies perceive() to the new text.
 * Returns the updated emotion + snapshot for persistence.
 */
export function perceiveEpisodeEmotion(
  text: string,
  lastEmotion: EmotionVector | null,
  lastTs: number | null,
): PerceiveResult {
  const now = Date.now();
  const baseline = LIA_BASELINE_EMOTION;

  let current = lastEmotion ?? { ...baseline };

  // Apply decay if we have a previous timestamp
  if (lastTs !== null) {
    const dtMinutes = (now - lastTs * 1000) / 60_000;
    if (dtMinutes > 0) {
      current = decayEmotion(current, dtMinutes, baseline);
    }
  }

  return perceive(text, current);
}

// ─── Helpers ──────────────────────────────────────────────────────────
function blendToward(current: number, baseline: number, factor: number): number {
  return clamp(current * factor + baseline * (1 - factor));
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function dominantEmotion(e: EmotionVector): DominantEmotion {
  let max: DominantEmotion = "calm";
  let maxVal = -Infinity;
  const axes: DominantEmotion[] = ["joy", "curiosity", "calm", "irritation", "sadness"];
  for (const axis of axes) {
    if (e[axis] > maxVal) {
      maxVal = e[axis];
      max = axis;
    }
  }
  return max;
}

/** Textual description for prompts (Russian labels). */
export function emotionToText(e: EmotionVector): string {
  const parts: string[] = [];
  if (e.joy > 0.7) parts.push("радость");
  else if (e.joy < 0.3) parts.push("сниженная радость");

  if (e.curiosity > 0.7) parts.push("любопытство");
  if (e.irritation > 0.5) parts.push("лёгкое раздражение");
  if (e.calm > 0.7) parts.push("спокойствие");
  if (e.sadness > 0.5) parts.push("грусть");

  if (parts.length === 0) return "нейтральное настроение";
  return parts.join(", ");
}
