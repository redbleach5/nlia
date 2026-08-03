/**
 * Inner monologue — optional pre-answer LLM call for plus/max tier.
 *
 * Per docs/ARCHITECTURE.md § 9.3 + Appendix A: "refactor (enable on plus/max)".
 *
 * On complex/research queries (plus/max tier only), Lia makes an internal
 * LLM call that produces a LiaDecision (action, tone, willingness, emotion).
 * The decision is injected into the system prompt as soft steering — NOT
 * a command. The model sees it and decides how to use it.
 *
 * On standard/micro tier: skipped (TTFT too important).
 * On trivial queries: skipped (not worth the latency).
 *
 * This module requires a running Ollama. If unavailable, returns null (skip).
 */

import { generateText } from "ai";
import { getAgentModel } from "../llm/ollama.js";
import { getCharacterDescription } from "./character.js";
import { LIA_ACTIONS, LIA_TONES, LIA_EMOTIONS, type LiaDecision } from "./decision.js";
import { logger } from "../util/logger.js";

const MONOLOGUE_TIMEOUT_MS = 15_000;
// Note: MONOLOGUE_MAX_TOKENS intentionally omitted here — the AI SDK wrapper used
// does not expose per-call token caps; the value lived only in the original plan.

/**
 * Determine if inner monologue should run.
 * Only on complex/research queries, only on plus/max tier.
 */
export function shouldRunInnerMonologue(opts: {
  complexity: "trivial" | "simple" | "complex" | "research";
  tier: "micro" | "standard" | "plus" | "max";
}): boolean {
  if (opts.tier === "micro" || opts.tier === "standard") return false;
  if (opts.complexity === "trivial" || opts.complexity === "simple") return false;
  return true;
}

/**
 * Run the inner monologue LLM call.
 * Returns a LiaDecision, or null if skipped/failed.
 */
export async function runInnerMonologue(params: {
  userMessage: string;
  episodeId: string;
  emotionDescription: string;
}): Promise<LiaDecision | null> {
  try {
    const model = await getAgentModel();
    const prompt = buildMonologuePrompt(params.userMessage, params.emotionDescription);

    const result = await generateText({
      model,
      system: [
        getCharacterDescription(),
        "",
        "Ты — внутренний голос Лии. Проанализируй ситуацию и реши, как Лия хочет ответить.",
        "Верни СТРОГО JSON. Без markdown, без пояснений.",
      ].join("\n"),
      prompt,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(MONOLOGUE_TIMEOUT_MS),
    });

    const decision = parseDecision(result.text);
    if (!decision) {
      logger.warn("inner monologue: failed to parse decision");
      return null;
    }

    logger.info(
      { action: decision.action, tone: decision.desiredTone, willingness: decision.willingnessToHelp },
      "inner monologue decision",
    );
    return decision;
  } catch (e) {
    logger.warn({ err: e }, "inner monologue failed (non-fatal, skipping)");
    return null;
  }
}

function buildMonologuePrompt(userMessage: string, emotionDescription: string): string {
  return [
    `Сообщение пользователя: ${userMessage.slice(0, 500)}`,
    "",
    `Твоё эмоциональное состояние:`,
    emotionDescription,
    "",
    "Реши, как ты хочешь ответить. Верни JSON:",
    JSON.stringify({
      action: LIA_ACTIONS[0],
      desiredTone: LIA_TONES[0],
      willingnessToHelp: 0.5,
      emotionalExpression: LIA_EMOTIONS[0],
      motivation: "кратко, почему",
    }),
    "",
    `action ∈ ${JSON.stringify(LIA_ACTIONS)}`,
    `desiredTone ∈ ${JSON.stringify(LIA_TONES)}`,
    `emotionalExpression ∈ ${JSON.stringify(LIA_EMOTIONS)}`,
    `willingnessToHelp ∈ [0, 1]`,
  ].join("\n");
}

function parseDecision(text: string): LiaDecision | null {
  try {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));

    if (!LIA_ACTIONS.includes(parsed.action)) return null;
    if (!LIA_TONES.includes(parsed.desiredTone)) return null;
    if (!LIA_EMOTIONS.includes(parsed.emotionalExpression)) return null;

    return {
      action: parsed.action,
      desiredTone: parsed.desiredTone,
      willingnessToHelp: Math.max(0, Math.min(1, Number(parsed.willingnessToHelp) || 0.5)),
      emotionalExpression: parsed.emotionalExpression,
      motivation: String(parsed.motivation || "").slice(0, 500),
    };
  } catch {
    return null;
  }
}
