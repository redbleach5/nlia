/**
 * Reflection engine — FULL implementation (replaces M3 stub).
 *
 * Per docs/ARCHITECTURE.md § 10.4.
 * Periodic consolidation: reads decisions + emotional memories + episode
 * summaries → LLM call generates long-term insights → persisted as GlobalFacts.
 *
 * Triggers:
 *   - Explicit user request ("что мы обсуждали?")
 *   - Episode close (if significant emotional memories exist)
 *   - Every N episodes (periodic)
 */

import { generateText } from "ai";
import { getChatModel } from "../llm/ollama.js";
import { getRecentEmotionalMemories, type EmotionalMemoryDTO } from "./emotional-memory.js";
import { getAllGlobalFacts, type GlobalFactDTO } from "./facts.js";
import { listDecisions, type DecisionDTO } from "./decisions.js";
import { listEpisodes } from "../services/episodes.js";
import { persistReflectionFacts } from "./reflection-engine.js";
import { extractJson } from "../infra/prompt-safety.js";
import { logger } from "../util/logger.js";

const REFLECTION_TIMEOUT_MS = 60_000;
const MIN_EMOTIONAL_MEMORIES_FOR_REFLECTION = 3;

/** Input gathered for the reflection LLM call. */
export interface ReflectionInput {
  episodeId: string;
  emotionalMemories: EmotionalMemoryDTO[];
  decisions: DecisionDTO[];
  existingGlobalFacts: GlobalFactDTO[];
  recentEpisodes: Array<{ id: string; title: string | null; summary: string | null }>;
}

const REFLECTION_PROMPT = `Проанализируй историю общения с пользователем и извлеки долгосрочные инсайты.

Правила:
1. Только УСТОЙЧИВЫЕ факты (не разовые упоминания). Например: "пользователь часто работает с Python" → да. "пользователь упомянул Python один раз" → нет.
2. Формат: JSON {"facts": [{"key": "user.preference_language", "value": "Python > JavaScript"}, ...]}
3. Ключи с префиксом user.* (профиль), lia.* (о себе), workspace.* (память проекта).
4. Не дублируй уже существующие факты.
5. Если новых инсайтов нет — верни {"facts": []}

Существующие факты:
{EXISTING_FACTS}

Недавние эмоциональные воспоминания:
{EMOTIONAL_MEMORIES}

Недавние решения:
{DECISIONS}

Недавние эпизоды:
{EPISODES}

Извлеки долгосрочные инсайты (JSON):`;

export async function runFullReflection(episodeId: string): Promise<{
  newFacts: Array<{ key: string; value: string }>;
  summary: string;
  ran: boolean;
}> {
  const emotionalMemories = getRecentEmotionalMemories(20);
  const decisions = listDecisions(episodeId, { limit: 10 });
  const existingFacts = getAllGlobalFacts();
  const recentEpisodes = listEpisodes(10).map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
  }));

  if (emotionalMemories.length < MIN_EMOTIONAL_MEMORIES_FOR_REFLECTION) {
    return {
      newFacts: [],
      summary: `Not enough emotional memories for reflection (${emotionalMemories.length} < ${MIN_EMOTIONAL_MEMORIES_FOR_REFLECTION}).`,
      ran: false,
    };
  }

  try {
    const model = await getChatModel();
    const prompt = REFLECTION_PROMPT
      .replace("{EXISTING_FACTS}", JSON.stringify(existingFacts.map((f) => ({ key: f.key, value: f.value })), null, 2))
      .replace("{EMOTIONAL_MEMORIES}", JSON.stringify(emotionalMemories.map((m) => ({
        emotion: m.emotion,
        trigger: m.trigger,
        context: m.context.slice(0, 200),
      })), null, 2))
      .replace("{DECISIONS}", JSON.stringify(decisions.map((d) => ({
        situation: d.situation.slice(0, 100),
        chosen: d.chosen,
        rationale: d.rationale.slice(0, 100),
      })), null, 2))
      .replace("{EPISODES}", JSON.stringify(recentEpisodes.map((e) => ({
        title: e.title,
        summary: e.summary?.slice(0, 200),
      })), null, 2));

    const result = await generateText({
      model,
      system: "Ты — модуль рефлексии. Анализируешь историю и извлекаешь долгосрочные инсайты. Возвращай только валидный JSON.",
      prompt,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(REFLECTION_TIMEOUT_MS),
    });

    const parsed = extractJson<{ facts?: Array<{ key: string; value: string }> }>(result.text);
    if (!parsed?.facts) {
      return { newFacts: [], summary: "Reflection completed but no facts extracted.", ran: true };
    }

    // Persist new facts
    persistReflectionFacts(parsed.facts);

    logger.info({ factCount: parsed.facts.length, episodeId }, "reflection completed with new facts");

    return {
      newFacts: parsed.facts,
      summary: `Reflection completed. Extracted ${parsed.facts.length} new facts from ${emotionalMemories.length} emotional memories, ${decisions.length} decisions, ${recentEpisodes.length} episodes.`,
      ran: true,
    };
  } catch (e) {
    logger.warn({ err: e, episodeId }, "reflection failed (non-fatal)");
    return {
      newFacts: [],
      summary: `Reflection failed: ${e instanceof Error ? e.message : String(e)}`,
      ran: false,
    };
  }
}
