// Эмоции Lia — 5-осевая модель.
// БЕЗ LLM-классификации: rule-based perceive + экспоненциальный decay к resting baseline.
// Resting = temperament (personality) softened by recent companion emotion (experience).
//
// Это чинит багу LIA v1, где LLM-вызов classify.yml часто ошибался
// (например, помечал "купи молоко" как rudeness) и загрязнял эмоциональное состояние.

import { LIA_PERSONALITY, type EmotionVector, type EmotionAxis } from './personality';

export function createInitialEmotion(): EmotionVector {
  return { ...LIA_PERSONALITY.baselineEmotion };
}

export function parseEmotionJson(json: string): EmotionVector | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj !== 'object' || obj === null) return null;
    const e = obj as Record<string, unknown>;
    return {
      joy: typeof e.joy === 'number' ? e.joy : 0.5,
      curiosity: typeof e.curiosity === 'number' ? e.curiosity : 0.5,
      calm: typeof e.calm === 'number' ? e.calm : 0.7,
      irritation: typeof e.irritation === 'number' ? e.irritation : 0.1,
      sadness: typeof e.sadness === 'number' ? e.sadness : 0.15,
    };
  } catch {
    return null;
  }
}

// ============================================================================
  // Rule-based perceive — what stimulus does the user message create?
  // NOT “what Lia decided she feels about the person” — that is monologue.
  // ============================================================================
  // Эвристики (Cyrillic-safe regex). БЕЗ LLM-вызова.
  // На каждый trigger — детерминированный delta к эмоциям (вспышка, не приказ).

type Trigger =
  | 'warmth'
  | 'rudeness'
  | 'sadTopic'
  | 'enthusiasm'
  | 'curiosity'
  | 'deepQuestion'
  | 'disagreement'
  | 'task'
  | 'trivial';

const TRIGGERS: Array<{ name: Trigger; regex: RegExp; weight: number }> = [
  // грубость — только настоящие оскорбления
  { name: 'rudeness', regex: /(?:^|[^a-zа-яё0-9_])(иди|отстань|заткнис|дурак|тупой|раздражаешь|бесишь|чушь|бред|хрень|идиот|придурок|урод|сволочь|нахуй|пизд|ебан|сука)(?![a-zа-яё0-9_])/iu, weight: 0.9 },

  // грустные темы
  { name: 'sadTopic', regex: /(умер|погиб|похорон|боле|рак|депресс|одинок|бросил|бросила|развод|умира|тяжело|не могу больше|устал жить)/i, weight: 0.8 },

  // энтузиазм
  { name: 'enthusiasm', regex: /(обожаю|получилось|ура|класс|супер|потрясающе|вау|шикарно|обалденно)/i, weight: 0.85 },

  // любопытство
  { name: 'curiosity', regex: /(почему|как устроен|как работает|откуда|зачем нужно|что будет если)/i, weight: 0.7 },

  // глубокие вопросы
  { name: 'deepQuestion', regex: /(в чём смысл|что такое.*на самом деле|существует ли|свобода воли|сознани|бессмерти|душа|бог|смерть|добро и зло)/i, weight: 0.85 },

  // тепло
  { name: 'warmth', regex: /(спасибо|благодар|доброе утро|добрый день|добрый вечер|привет|скучал|рад видеть|люблю тебя)/i, weight: 0.6 },

  // несогласие
  { name: 'disagreement', regex: /(не согласен|не согласна|ты неправ|ошибаешься|это не так|не верю|ерунда это)/i, weight: 0.65 },

  // задача — Lia любит помогать
  { name: 'task', regex: /(найди|поиск|загугли|создай|напиши|сделай|нарисуй|сгенерируй|проанализируй|проверь|обнови|исправь|оптимизируй|рефактор)/i, weight: 0.75 },

  // тривиальные вопросы
  { name: 'trivial', regex: /^(привет|как дела|что делаешь|как ты|приветик)\??\.?$/i, weight: 0.4 },
];

const EMOTION_DELTAS: Record<Trigger, Partial<EmotionVector>> = {
  warmth:       { joy: +0.20, calm: +0.15, irritation: -0.15, sadness: -0.10 },
  rudeness:     { irritation: +0.30, joy: -0.20, calm: -0.20, sadness: +0.10 },
  sadTopic:     { sadness: +0.30, joy: -0.20, calm: -0.10, curiosity: +0.05 },
  enthusiasm:   { joy: +0.25, curiosity: +0.10, calm: -0.05 },
  curiosity:    { curiosity: +0.20, joy: +0.05 },
  deepQuestion: { curiosity: +0.25, joy: +0.10, irritation: -0.10 },
  disagreement: { curiosity: +0.15, irritation: +0.05, calm: -0.05 },
  task:         { curiosity: +0.15, joy: +0.05 },
  trivial:      { curiosity: -0.05, irritation: +0.02 },
};

export function perceive(text: string, current: EmotionVector): {
  emotion: EmotionVector;
  triggers: Trigger[];
} {
  const emotion = { ...current };
  const triggers: Trigger[] = [];

  for (const { name, regex, weight } of TRIGGERS) {
    if (regex.test(text)) {
      triggers.push(name);
      const delta = EMOTION_DELTAS[name];
      for (const axis in delta) {
        const a = axis as EmotionAxis;
        emotion[a] = clamp(emotion[a] + (delta[a] ?? 0) * weight);
      }
    }
  }

  return { emotion, triggers };
}

// ============================================================================
// Decay — exponential toward baseline per minute
// ============================================================================
const DECAY_PER_MIN = 0.02;

export function decayEmotion(
  current: EmotionVector,
  dtMinutes: number,
  baseline: EmotionVector = LIA_PERSONALITY.baselineEmotion,
): EmotionVector {
  const factor = Math.exp(-DECAY_PER_MIN * dtMinutes);
  return {
    joy:        blendToward(current.joy, baseline.joy, factor),
    curiosity:  blendToward(current.curiosity, baseline.curiosity, factor),
    calm:       blendToward(current.calm, baseline.calm, factor),
    irritation: blendToward(current.irritation, baseline.irritation, factor),
    sadness:    blendToward(current.sadness, baseline.sadness, factor),
  };
}

/** Max axis drift from personality temperament toward lived experience. */
const BASELINE_MAX_DRIFT = 0.2;
/** How much recent companion emotion pulls the resting point (rest = identity). */
const BASELINE_EXPERIENCE_WEIGHT = 0.35;

/**
 * Resting emotion for decay: personality temperament softened by recent
 * companion emotion snapshots (experience), clamped so identity stays the anchor.
 */
export function resolveDecayBaseline(
  recentEmotions: EmotionVector[],
  personality: EmotionVector = LIA_PERSONALITY.baselineEmotion,
): EmotionVector {
  if (recentEmotions.length === 0) return { ...personality };

  const avg: EmotionVector = {
    joy: 0, curiosity: 0, calm: 0, irritation: 0, sadness: 0,
  };
  for (const e of recentEmotions) {
    avg.joy += e.joy;
    avg.curiosity += e.curiosity;
    avg.calm += e.calm;
    avg.irritation += e.irritation;
    avg.sadness += e.sadness;
  }
  const n = recentEmotions.length;
  avg.joy /= n;
  avg.curiosity /= n;
  avg.calm /= n;
  avg.irritation /= n;
  avg.sadness /= n;

  const w = BASELINE_EXPERIENCE_WEIGHT;
  const blend = (p: number, a: number) =>
    clampToRange(p * (1 - w) + a * w, p - BASELINE_MAX_DRIFT, p + BASELINE_MAX_DRIFT);

  return {
    joy: blend(personality.joy, avg.joy),
    curiosity: blend(personality.curiosity, avg.curiosity),
    calm: blend(personality.calm, avg.calm),
    irritation: blend(personality.irritation, avg.irritation),
    sadness: blend(personality.sadness, avg.sadness),
  };
}

function blendToward(current: number, baseline: number, factor: number): number {
  return clamp(current * factor + baseline * (1 - factor));
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampToRange(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, clamp(v)));
}

// ============================================================================
// Textual description for the prompt
// ============================================================================
export function emotionToText(e: EmotionVector): string {
  const parts: string[] = [];
  if (e.joy > 0.7) parts.push('радость');
  else if (e.joy < 0.3) parts.push('грусть');

  if (e.curiosity > 0.7) parts.push('любопытство');
  if (e.irritation > 0.5) parts.push('лёгкое раздражение');
  if (e.calm > 0.7) parts.push('спокойствие');
  if (e.sadness > 0.5) parts.push('грусть');

  if (parts.length === 0) return 'нейтральное настроение';
  return parts.join(', ');
}

export function dominantEmotion(e: EmotionVector): EmotionAxis {
  let max: EmotionAxis = 'joy';
  let maxVal = -Infinity;
  for (const axis of ['joy', 'curiosity', 'calm', 'irritation', 'sadness'] as EmotionAxis[]) {
    if (e[axis] > maxVal) {
      maxVal = e[axis];
      max = axis;
    }
  }
  return max;
}
