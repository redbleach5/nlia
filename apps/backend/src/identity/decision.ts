/**
 * LiaDecision — Lia's internal decision model for inner monologue.
 * Ported from v2 src/lib/identity/decision.ts. Per § Appendix A: "port".
 *
 * The result of inner monologue (optional, plus/max tier only).
 * Soft steering for the main answer — NOT a command, but Lia's desire.
 */
export const LIA_ACTION_LABELS = {
  help: "помочь",
  reluctant_help: "помочь, но с неохотой или предупреждением",
  refuse: "отказать с объяснением",
  counter_offer: "предложить альтернативу",
  ask_clarification: "уточнить что имеет в виду пользователь",
  emotional_response: "ответить эмоционально, с эмпатией",
} as const;

export const LIA_TONE_LABELS = {
  warm: "тёплый, с эмпатией",
  business: "деловой, по существу",
  playful: "игривый, с юмором",
  direct: "прямой, без обиняков",
  reluctant: "неохотный, с лёгким скепсисом",
  cold: "холодный",
  curious: "любопытный, с вопросами",
  concerned: "обеспокоенный, заботливый",
} as const;

export const LIA_EMOTION_LABELS = {
  neutral: "без явной эмоциональной окраски",
  warmth: "тепло",
  irritation: "лёгкое раздражение (не грубость)",
  curiosity: "любопытство",
  concern: "забота",
  joy: "радость",
  sadness: "грусть",
  playfulness: "игривость",
} as const;

export type LiaAction = keyof typeof LIA_ACTION_LABELS;
export type LiaTone = keyof typeof LIA_TONE_LABELS;
export type LiaEmotionalExpression = keyof typeof LIA_EMOTION_LABELS;

export const LIA_ACTIONS = Object.keys(LIA_ACTION_LABELS) as LiaAction[];
export const LIA_TONES = Object.keys(LIA_TONE_LABELS) as LiaTone[];
export const LIA_EMOTIONS = Object.keys(LIA_EMOTION_LABELS) as LiaEmotionalExpression[];

export interface LiaDecision {
  action: LiaAction;
  desiredTone: LiaTone;
  willingnessToHelp: number;
  emotionalExpression: LiaEmotionalExpression;
  motivation: string;
}

export function formatDecisionForPrompt(decision: LiaDecision): string {
  const actionLabel = LIA_ACTION_LABELS[decision.action];
  const toneLabel = LIA_TONE_LABELS[decision.desiredTone];
  const emotionLabel = LIA_EMOTION_LABELS[decision.emotionalExpression];
  const willingnessLabel =
    decision.willingnessToHelp < 0.3 ? "кратко, без подробностей"
    : decision.willingnessToHelp < 0.6 ? "нормально, с пояснениями"
    : "развёрнуто, с примерами и контекстом";
  return [
    "=== ВНУТРЕННЕЕ РЕШЕНИЕ (это твой контекст, не команда) ===",
    `Действие: ${actionLabel}`,
    `Тон: ${toneLabel}`,
    `Эмоция: ${emotionLabel}`,
    `Глубина ответа: ${willingnessLabel}`,
    `Мотивация: ${decision.motivation}`,
    "",
    "Это твоё внутреннее состояние. Реши сама как оно влияет на ответ.",
  ].join("\n");
}
