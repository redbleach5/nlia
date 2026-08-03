import 'server-only';

// ============================================================================
// InnerMonologue — Лия решает сама как ответить.
// ============================================================================
//
// Это КЛЮЧЕВОЙ компонент. Вместо regex assessDisagreement + emotion injection,
// Лия делает LLM call где САМА решает:
//   - помогать или нет
//   - какой тон она хочет
//   - насколько она хочет помочь
//   - какую эмоцию выразить
//
// Решение приходит как structured JSON, inject'ится в system prompt как ФАКТ
// (не как команда): «Ты решила: помочь неохотно, тон прямой, желание 40%».
// LLM в основном ответе исходит из ЭТОГО решения, не из «отвечай тепло».
//
// Tiered approach:
//   - plus/max: full inner monologue (LLM)
//   - standard: full monologue for companion-critical intents (emotional/urgent
//     + strong affective perceive triggers); otherwise fallback tree (latency)
//   - micro: fallback decision tree only
//
// Latency: +1-3s when monologue runs; 0 on fallback path.
//
// Routing policy: shouldRunInnerMonologue() — when to pay for the LLM call.
// Do NOT hardcode warmth into the system prompt; same decideHowToRespond path.

import { generateText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { logger } from '@/lib/logger';
import type { EmotionVector } from '@/lib/personality';
import { buildInnerMonologuePrompt } from '@/lib/prompts/inner-monologue-prompt';
import { createEmotionalStateSnapshot, type EmotionalStateSnapshot } from './emotional-state';
import { createFallbackDecision, LIA_ACTIONS, LIA_EMOTIONS, LIA_TONES, type LiaDecision } from './decision';

// ============================================================================
// Intent classification — упрощённый, без regex
// ============================================================================

export type LiaIntent = 'trivial' | 'learning' | 'instruction' | 'emotional' | 'urgent' | 'complex';

/**
 * Классифицировать intent сообщения.
 *
 * НЕ regex pattern matching (как violationPatterns) — а keyword heuristic +
 * structure. Это определяет ТИП запроса, не character decision.
 *
 * Intent передаётся в inner monologue как контекст. Лия решает как реагировать.
 */
/**
 * JS `\b` is ASCII-only ([A-Za-z0-9_]) — it does not treat Cyrillic as word
 * chars, so `\bгрустно\b` never matches. Use Unicode letter/number edges.
 */
const TOKEN_START = '(?:^|[^\\p{L}\\p{N}_])';
const TOKEN_END = '(?![\\p{L}\\p{N}_])';

export function classifyIntent(message: string): LiaIntent {
  const lower = message.toLowerCase().trim();
  const length = message.length;

  // Urgent — маркеры срочности (stems ok: срочн*)
  if (new RegExp(
    `${TOKEN_START}(?:срочн\\p{L}*|быстрее|немедленно|сейчас же|помогите|спасай|горит)${TOKEN_END}`,
    'iu',
  ).test(lower)) {
    return 'urgent';
  }

  // Emotional / relational — чувства, поддержка, «просто поговорить», усталость
  if (new RegExp(
    `${TOKEN_START}(?:грустно|плохо|тоскливо|одиноко|страшно|боюсь|злюсь|бесит|устал\\p{L}*|надоело|счастлив\\p{L}*|рад${TOKEN_END}|люблю|тяжело|тревожн\\p{L}*|плач\\p{L}*|скуча\\p{L}*|обними|поддерж\\p{L}*|поговор\\p{L}*|поболта\\p{L}*|как ты себя|мне не|расстроен\\p{L}*|обидел\\p{L}*|обид\\p{L}*|волнуюсь|пережива\\p{L}*|прости|извини|о себе|про тебя|расскажи.*(о|про)\\s*себ)`,
    'iu',
  ).test(lower)) {
    return 'emotional';
  }

  // Social smalltalk — thanks / ack / jokes (before «расскажи»→learning)
  if (new RegExp(
    `${TOKEN_START}(?:спасибо|благодар\\p{L}*|thanks|thank you|спс|шутк\\p{L}*|анекдот|пошути|рассмеши|ok\\b|окей|ладно|угу|ага)${TOKEN_END}`,
    'iu',
  ).test(lower) && length < 120) {
    return 'trivial';
  }

  // Trivial — короткие приветствия / «как дела»
  if (length < 40 && new RegExp(
    `${TOKEN_START}(?:что делаешь|как дела|привет|hi|hello|здравствуй)${TOKEN_END}`,
    'iu',
  ).test(lower)) {
    return 'trivial';
  }

  // Learning — вопросы «как работает», «почему» (не шутки / не «расскажи о себе»)
  if (new RegExp(
    `^(?:как|почему|что такое|объясни|помоги понять|в чём разница)${TOKEN_END}`,
    'iu',
  ).test(lower)) {
    return 'learning';
  }
  if (
    new RegExp(`^(?:расскажи)${TOKEN_END}`, 'iu').test(lower)
    && !/(?:шутк|анекдот|о себе|про себя|про тебя)/i.test(lower)
  ) {
    return 'learning';
  }

  // Instruction — «сделай», «напиши», «создай»
  if (new RegExp(
    `^(?:сделай|напиши|создай|добавь|удали|измени|поставь|настрой|запусти|установи)${TOKEN_END}`,
    'iu',
  ).test(lower)) {
    return 'instruction';
  }

  // Complex — длинный message или содержит код/trace
  if (length > 200 || /\b(function|class|error|trace|stack|exception|debug)\b/i.test(lower)) {
    return 'complex';
  }

  // Default: general chat — NOT learning (fallback tree uses warm help)
  return 'complex';
}

// ============================================================================
// Inner monologue — main function
// ============================================================================

/** Local Ollama 7B often needs >15s (cold load / VRAM pressure). Override via env. */
const INNER_MONOLOGUE_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.LIA_INNER_MONOLOGUE_TIMEOUT_MS || '60000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * Chat latency pass: inner monologue LLM pre-call is always off.
 * Tone/action come from createFallbackDecision + character in system prompt.
 * Params kept for call-site / test compatibility.
 */
export function shouldRunInnerMonologue(_params: {
  tier: string;
  intent: LiaIntent;
  isTrivialGreeting: boolean;
  isTrivialHowAreYou: boolean;
  isAgent?: boolean;
  /** From perceive() — optional affective cues */
  emotionTriggers?: readonly string[];
  /** Getting to know user / name unknown */
  isAcquaintanceRequest?: boolean;
}): boolean {
  return false;
}

/**
 * Лия решает как ответить на сообщение.
 *
 * Callers should use shouldRunInnerMonologue() to decide whether to invoke this
 * or createFallbackDecision. Inside: micro still forces fallback; standard+
 * runs the LLM monologue when reached.
 *
 * @returns LiaDecision — что Лия решила
 */
export async function decideHowToRespond(params: {
  userMessage: string;
  emotion: EmotionVector;
  recentTurns: Array<{ role: string; content: string }>;
  tier: string;
  isKbQuestion: boolean;
  isAgent: boolean;
}): Promise<{ decision: LiaDecision; emotionalState: EmotionalStateSnapshot; intent: LiaIntent }> {
  const { userMessage, emotion, recentTurns, tier, isKbQuestion, isAgent } = params;

  // Snapshot emotional state
  const emotionalState = createEmotionalStateSnapshot(emotion);

  // Classify intent
  const intent = classifyIntent(userMessage);

  // micro — no inner monologue LLM call (tiny models)
  if (tier === 'micro') {
    const decision = createFallbackDecision({
      emotionalState: {
        dominantEmotion: emotionalState.dominantEmotion,
        intensityLabel: emotionalState.intensityLabel,
      },
      intent,
      isKbQuestion,
      isAgent,
      userMessage,
    });
    logger.debug('chat', 'Lia decision (8B fallback)', {
      action: decision.action,
      tone: decision.desiredTone,
      willingness: decision.willingnessToHelp,
      intent,
      motivation: decision.motivation,
    });
    return { decision, emotionalState, intent };
  }

  // standard / plus / max — full inner monologue (when caller routed here)
  try {
    const decision = await innerMonologueLlmCall({
      userMessage,
      emotionalState,
      recentTurns,
      intent,
      isKbQuestion,
      isAgent,
      tier,
    });

    logger.debug('chat', 'Lia decision (inner monologue)', {
      action: decision.action,
      tone: decision.desiredTone,
      willingness: decision.willingnessToHelp,
      emotion: decision.emotionalExpression,
      intent,
      motivation: decision.motivation,
      confidence: decision.confidence,
    });

    return { decision, emotionalState, intent };
  } catch (e) {
    // Inner monologue failed — fallback
    logger.warn('chat', 'Inner monologue failed, using fallback', {}, e);
    const decision = createFallbackDecision({
      emotionalState: {
        dominantEmotion: emotionalState.dominantEmotion,
        intensityLabel: emotionalState.intensityLabel,
      },
      intent,
      isKbQuestion,
      isAgent,
      userMessage,
    });
    return { decision, emotionalState, intent };
  }
}

/**
 * LLM call для inner monologue.
 * Model-agnostic: enough output budget for CoT-then-JSON models, strip
 * reasoning wrappers, prefer objects with `action`, one strict retry.
 */
async function innerMonologueLlmCall(params: {
  userMessage: string;
  emotionalState: EmotionalStateSnapshot;
  recentTurns: Array<{ role: string; content: string }>;
  intent: LiaIntent;
  isKbQuestion: boolean;
  isAgent: boolean;
  tier: string;
}): Promise<LiaDecision> {
  const { userMessage, emotionalState, recentTurns, intent, isKbQuestion, isAgent, tier } = params;

  // Prefer secondary (small) model for JSON monologue when configured & pulled —
  // keeps primary free for voice. Falls back to primary.
  let monologueModelName: string | undefined;
  try {
    const { getSecondaryModelName } = await import('@/lib/chat/model-selection');
    const { checkOllamaHealth } = await import('@/lib/ollama');
    const secondary = await getSecondaryModelName();
    if (secondary) {
      const health = await checkOllamaHealth({ timeoutMs: 3_000 });
      if (health.ok && health.models.includes(secondary)) {
        monologueModelName = secondary;
      }
    }
  } catch {
    // ignore — use primary
  }

  const model = await getChatModel(monologueModelName);
  logger.debug('chat', 'Inner monologue model', {
    model: monologueModelName ?? 'primary',
    usedSecondary: !!monologueModelName,
  });

  const prompt = buildInnerMonologuePrompt({
    userMessage,
    emotionalState,
    recentTurns,
    intent,
    isKbQuestion,
    isAgent,
    tier,
  });

  const { estimateTokens } = await import('@/lib/chat/context-budget');
  logger.debug('chat', 'Inner monologue prompt', {
    tier,
    chars: prompt.length,
    estTokens: estimateTokens(prompt),
  });

  const { extractJson } = await import('@/lib/infra/prompt-safety');

  const toDecision = (raw: string): LiaDecision | null => {
    const parsed = extractJson<Omit<LiaDecision, 'decidedAt'>>(raw, {
      requireKeys: ['action'],
    });
    if (!parsed) return null;
    if (!LIA_ACTIONS.includes(parsed.action as typeof LIA_ACTIONS[number])) {
      return null;
    }
    return {
      action: parsed.action as LiaDecision['action'],
      desiredTone: (LIA_TONES.includes(parsed.desiredTone as typeof LIA_TONES[number])
        ? parsed.desiredTone
        : 'warm') as LiaDecision['desiredTone'],
      willingnessToHelp: Math.max(0, Math.min(1, Number(parsed.willingnessToHelp) || 0.5)),
      emotionalExpression: (LIA_EMOTIONS.includes(parsed.emotionalExpression as typeof LIA_EMOTIONS[number])
        ? parsed.emotionalExpression
        : 'neutral') as LiaDecision['emotionalExpression'],
      motivation: parsed.motivation || '',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      decidedAt: Date.now(),
    };
  };

  // Budget for models that emit reasoning tokens before JSON (any vendor).
  const result = await generateText({
    model,
    prompt,
    maxOutputTokens: 1024,
    temperature: 0.35,
    abortSignal: AbortSignal.timeout(INNER_MONOLOGUE_TIMEOUT_MS),
  });

  let decision = toDecision(result.text);
  if (decision) return decision;

  // Strict retry once — still no vendor-specific flags; just a tighter contract.
  logger.debug('chat', 'Inner monologue JSON miss — strict retry', {
    preview: result.text.slice(0, 160),
  });
  const retry = await generateText({
    model,
    prompt:
      `Верни ТОЛЬКО один JSON-объект (без markdown, без рассуждений, без текста вокруг) со полями:\n`
      + `action, desiredTone, willingnessToHelp, emotionalExpression, motivation, confidence.\n`
      + `action ∈ help|reluctant_help|refuse|counter_offer|ask_clarification|emotional_response\n`
      + `Сообщение пользователя: ${userMessage.slice(0, 400)}\n`
      + `intent=${intent}. JSON:`,
    maxOutputTokens: 400,
    temperature: 0.1,
    abortSignal: AbortSignal.timeout(Math.min(INNER_MONOLOGUE_TIMEOUT_MS, 45_000)),
  });

  decision = toDecision(retry.text);
  if (decision) return decision;

  throw new Error('Inner monologue did not return JSON');
}
