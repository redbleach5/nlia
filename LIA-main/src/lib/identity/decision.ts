import 'server-only';

// ============================================================================
// LiaDecision — решение Лии как ответить.
// ============================================================================
//
// Результат inner monologue. Soft steering for the main answer:
//   - action: что делать (помочь / отказать / уточнить)
//   - desiredTone: какой тон она хочет (не команда, а её желание)
//   - willingnessToHelp: насколько она хочет помочь (0..1)
//   - emotionalExpression: какую эмоцию она хочет выразить
//   - motivation: кратко inject в system prompt + debug log
//
// Labels below are the single source of truth for prompt injection
// (system-prompt) and validation lists (inner-monologue). Keys = enum values.

/** Action → short Russian label for system prompt. */
export const LIA_ACTION_LABELS = {
  help: 'помочь',
  reluctant_help: 'помочь, но с неохотой или предупреждением',
  refuse: 'отказать с объяснением',
  counter_offer: 'предложить альтернативу',
  ask_clarification: 'уточнить что имеет в виду пользователь',
  emotional_response: 'ответить эмоционально, с эмпатией',
} as const;

/** Desired tone → short Russian label for system prompt. */
export const LIA_TONE_LABELS = {
  warm: 'тёплый, с эмпатией',
  business: 'деловой, по существу',
  playful: 'игривый, с юмором',
  direct: 'прямой, без обиняков',
  reluctant: 'неохотный, с лёгким скепсисом',
  cold: 'холодный',
  curious: 'любопытный, с вопросами',
  concerned: 'обеспокоенный, заботливый',
} as const;

/** Emotional expression → short Russian label for system prompt. */
export const LIA_EMOTION_LABELS = {
  neutral: 'без явной эмоциональной окраски',
  warmth: 'тепло',
  irritation: 'лёгкое раздражение (не грубость)',
  curiosity: 'любопытство',
  concern: 'забота',
  joy: 'радость',
  sadness: 'грусть',
  playfulness: 'игривость',
} as const;

export type LiaAction = keyof typeof LIA_ACTION_LABELS;
export type LiaTone = keyof typeof LIA_TONE_LABELS;
export type LiaEmotionalExpression = keyof typeof LIA_EMOTION_LABELS;

export const LIA_ACTIONS = Object.keys(LIA_ACTION_LABELS) as LiaAction[];
export const LIA_TONES = Object.keys(LIA_TONE_LABELS) as LiaTone[];
export const LIA_EMOTIONS = Object.keys(LIA_EMOTION_LABELS) as LiaEmotionalExpression[];

export interface LiaDecision {
  // Что Лия решила делать
  action: LiaAction;

  // Какой тон Лия хочет (это ЕЁ желание, не команда системе)
  desiredTone: LiaTone;

  // Насколько Лия хочет помочь (0..1) — влияет на длину/глубину ответа
  // 0.2 — кратко, без подробностей
  // 0.5 — нормально, с пояснениями
  // 0.9 — развёрнуто, с примерами и контекстом
  willingnessToHelp: number;

  // Какую эмоцию Лия хочет выразить в ответе
  emotionalExpression: LiaEmotionalExpression;

  // Внутренняя мотивация — почему Лия решила так.
  // Кратко inject'ится в system prompt как «внутренняя опора»; также:
  //   - логирование (debug)
  //   - audit trail
  motivation: string;

  // Confidence в решении (0..1) — logged; does not currently gate fallback
  confidence: number;

  // Timestamp для логирования
  decidedAt: number;
}

/**
 * Fallback решение для 8B tier или когда inner monologue недоступен.
 *
 * Упрощённая decision tree: emotional state + intent + лёгкие cues в тексте.
 * Не violationPatterns — только чтобы не схлопываться в help/curious.
 */
export function createFallbackDecision(params: {
  emotionalState: { dominantEmotion: string; intensityLabel: string };
  intent: 'trivial' | 'learning' | 'instruction' | 'emotional' | 'urgent' | 'complex';
  isKbQuestion: boolean;
  isAgent: boolean;
  /** Optional raw user text for light social cues (jokes, about-you, fatigue). */
  userMessage?: string;
}): LiaDecision {
  const { emotionalState, intent, isKbQuestion, isAgent } = params;
  const msg = (params.userMessage ?? '').toLowerCase();

  // Agent mode — всегда help, business tone, neutral emotion
  if (isAgent) {
    return {
      action: 'help',
      desiredTone: 'business',
      willingnessToHelp: 0.7,
      emotionalExpression: 'neutral',
      motivation: 'Agent mode — выполняю задачу, эмоции отключены',
      confidence: 0.6,
      decidedAt: Date.now(),
    };
  }

  // KB question — help, business/curious tone, neutral emotion
  if (isKbQuestion) {
    return {
      action: 'help',
      desiredTone: emotionalState.dominantEmotion === 'curiosity' ? 'curious' : 'business',
      willingnessToHelp: 0.8,
      emotionalExpression: 'neutral',
      motivation: 'KB question — отвечаю по фактам, без эмоциональной окраски',
      confidence: 0.7,
      decidedAt: Date.now(),
    };
  }

  // Urgent — помочь даже если раздражена
  if (intent === 'urgent') {
    return {
      action: 'help',
      desiredTone: 'direct',
      willingnessToHelp: 0.9,
      emotionalExpression: emotionalState.dominantEmotion === 'sadness' ? 'concern' : 'neutral',
      motivation: 'Срочный запрос — помогаю несмотря на состояние',
      confidence: 0.7,
      decidedAt: Date.now(),
    };
  }

  // Light cues (before generic trivial/learning) — keep Lia varied when monologue fails
  if (msg && /шутк|анекдот|пошути|рассмеши/.test(msg)) {
    return {
      action: 'help',
      desiredTone: 'playful',
      willingnessToHelp: 0.55,
      emotionalExpression: 'playfulness',
      motivation: 'Просят шутку — отвечаю легко, без инструктажа',
      confidence: 0.65,
      decidedAt: Date.now(),
    };
  }
  if (msg && /(про тебя|о тебе|о себе|про себя|расскажи.*(о|про)\s*себ)/.test(msg)) {
    return {
      action: 'emotional_response',
      desiredTone: 'warm',
      willingnessToHelp: 0.6,
      emotionalExpression: 'warmth',
      motivation: 'Спрашивают обо мне — говорю о себе, не увожу в опрос собеседника',
      confidence: 0.6,
      decidedAt: Date.now(),
    };
  }
  if (msg && /устал|устала|😭|тяжело сейчас|ничего не помн/.test(msg)) {
    return {
      action: 'emotional_response',
      desiredTone: 'concerned',
      willingnessToHelp: 0.55,
      emotionalExpression: 'concern',
      motivation: 'Человек устал — присутствие важнее советов',
      confidence: 0.6,
      decidedAt: Date.now(),
    };
  }
  if (msg && /спасибо|благодарю|thanks/.test(msg)) {
    return {
      action: 'help',
      desiredTone: 'warm',
      willingnessToHelp: 0.45,
      emotionalExpression: 'warmth',
      motivation: 'Благодарность — коротко и тепло, без эссе',
      confidence: 0.7,
      decidedAt: Date.now(),
    };
  }

  // Trivial + раздражена → reluctant help
  if (intent === 'trivial' && emotionalState.dominantEmotion === 'irritation' && emotionalState.intensityLabel === 'high') {
    return {
      action: 'reluctant_help',
      desiredTone: 'reluctant',
      willingnessToHelp: 0.4,
      emotionalExpression: 'irritation',
      motivation: 'Банальный вопрос + раздражение — помогу кратко, дам понять что могла бы сама найти',
      confidence: 0.5,
      decidedAt: Date.now(),
    };
  }

  // Trivial smalltalk — коротко и тепло (не learning/curiosity)
  if (intent === 'trivial') {
    return {
      action: 'help',
      desiredTone: 'warm',
      willingnessToHelp: 0.55,
      emotionalExpression: 'warmth',
      motivation: 'Короткий smalltalk — отвечаю кратко',
      confidence: 0.7,
      decidedAt: Date.now(),
    };
  }

  // Learning question → help with curiosity
  if (intent === 'learning') {
    return {
      action: 'help',
      desiredTone: 'curious',
      willingnessToHelp: 0.8,
      emotionalExpression: 'curiosity',
      motivation: 'Обучающий вопрос — помогаю с интересом',
      confidence: 0.7,
      decidedAt: Date.now(),
    };
  }

  // Emotional conversation → she answers as herself; reciprocity is not required.
  if (intent === 'emotional') {
    return {
      action: 'emotional_response',
      desiredTone: emotionalState.dominantEmotion === 'sadness' ? 'concerned' : 'warm',
      willingnessToHelp: 0.7,
      emotionalExpression: emotionalState.dominantEmotion === 'sadness' ? 'concern' : 'warmth',
      motivation:
        'Эмоциональный разговор — отвечаю честно из характера; взаимность чувств и обязательное утешение не требуются',
      confidence: 0.55,
      decidedAt: Date.now(),
    };
  }

  // Default — help, warm tone
  return {
    action: 'help',
    desiredTone: emotionalState.dominantEmotion === 'irritation' ? 'direct' : 'warm',
    willingnessToHelp: 0.7,
    emotionalExpression: 'neutral',
    motivation: 'Обычный запрос — помогаю в своём текущем тоне',
    confidence: 0.6,
    decidedAt: Date.now(),
  };
}
