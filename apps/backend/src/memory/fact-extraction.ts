/**
 * Fact extraction — LLM-based extraction of facts from dialogue.
 *
 * Ported from v2 src/lib/memory/fact-extraction.ts (simplified for M3).
 * Per docs/ARCHITECTURE.md § 10.1.
 *
 * Called AFTER each companion turn (background, non-blocking).
 * Extracts:
 *   - Global facts (user profile): user.name, user.profession, etc.
 *   - Episode facts (current context): current.project, current.task, etc.
 *
 * Triggers: only on messages that look like they contain facts (pattern matching).
 * This avoids a wasted LLM call on every "привет" / "ок" / "спасибо".
 */

import { generateText } from "ai";
import { getChatModel } from "../llm/ollama.js";
import { upsertEpisodeFact, upsertGlobalFact } from "./facts.js";
import { remember } from "./vector.js";
import { logger } from "../util/logger.js";

// ─── Trigger patterns — only extract when these match ────────────────
const FACT_TRIGGER_PATTERNS = [
  /(?<![\p{L}\p{N}])(меня зовут|моё имя|я [\wа-яё]+,? а ты|зови меня)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(я работаю|я учусь|моя профессия|по профессии)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мне \d+ лет|мне исполнилось)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мой проект|я делаю|я пишу|я разрабатываю|мы работаем над)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(использую|пишу на|язык программирования|фреймворк)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мне нравится|я люблю|не люблю|предпочитаю|мой любимый)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(моя цель|я хочу сделать|планирую|задача —)(?![\p{L}\p{N}])/iu,
];

const MIN_LENGTH_FOR_EXTRACTION = 200;

function shouldExtractFacts(userMessage: string): boolean {
  if (userMessage.length < 30) return false;
  if (userMessage.length > MIN_LENGTH_FOR_EXTRACTION) return true;
  return FACT_TRIGGER_PATTERNS.some((re) => re.test(userMessage));
}

const EXTRACTION_PROMPT = `Проанализируй диалог между пользователем и ассистентом Лией.
Извлеки ФАКТЫ — устойчивую информацию о пользователе и контексте.

Правила:
1. Только ФАКТЫ, не интерпретации. "Меня зовут Иван" → user.name: Иван. Не "пользователь представился".
2. Глобальные факты (профиль пользователя): префикс "user."
   - user.name — имя
   - user.profession — профессия
   - user.age — возраст
   - user.favorite_language — любимый язык программирования
   - user.location — где живёт
3. Эпизодные факты (контекст текущего чата): префикс "current."
   - current.project — над чем работает
   - current.task — что делает сейчас
   - current.topic — тема обсуждения
   - current.tech_stack — используемые технологии
4. Если информации нет — не включай. Не выдумывай.
5. Если факт уже известен и не изменился — не дублируй.
6. Формат: строго JSON {"global": {"name": "Иван", ...}, "episode": {"project": "...", ...}}
   В ключах JSON — БЕЗ префиксов user./current. (их добавит система).
7. Если фактов нет — верни {"global": {}, "episode": {}}

Диалог:
Пользователь: {USER_MSG}
Лия: {LIA_MSG}

Извлеки факты (JSON):`;

/**
 * Normalize a fact key: strip user./current. prefixes, sanitize, re-add prefix.
 */
function normalizeFactStorageKey(rawKey: string, prefix: "user" | "current"): string | null {
  let key = rawKey.trim();
  if (!key) return null;
  while (/^(user|current)\./i.test(key)) {
    key = key.replace(/^(user|current)\./i, "");
  }
  key = key.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "");
  if (!key || key.length > 64) return null;
  return `${prefix}.${key.toLowerCase()}`;
}

interface ExtractedFacts {
  global?: Record<string, string>;
  episode?: Record<string, string>;
}

/**
 * Extract a JSON object from LLM output.
 * Handles markdown code fences + leading/trailing prose.
 */
function extractJson(text: string): ExtractedFacts | null {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
  // Find the first { and last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as ExtractedFacts;
  } catch {
    return null;
  }
}

/**
 * Extract and save facts from a dialogue turn.
 * Background call — non-blocking, non-throwing.
 *
 * @returns {globalCount, episodeCount} — 0 if extraction was skipped or failed
 */
export async function extractAndSaveFacts(params: {
  userMessage: string;
  liaMessage: string;
  episodeId: string;
}): Promise<{ globalCount: number; episodeCount: number }> {
  const { userMessage, liaMessage, episodeId } = params;

  if (!shouldExtractFacts(userMessage)) {
    return { globalCount: 0, episodeCount: 0 };
  }

  try {
    const model = await getChatModel();
    const prompt = EXTRACTION_PROMPT.replace("{USER_MSG}", userMessage.slice(0, 1000)).replace(
      "{LIA_MSG}",
      liaMessage.slice(0, 500),
    );

    const result = await generateText({
      model,
      system: "Ты — модуль извлечения фактов. Возвращай только валидный JSON, без markdown.",
      prompt,
      temperature: 0.1,
      abortSignal: AbortSignal.timeout(30_000),
    });

    const parsed = extractJson(result.text);
    if (!parsed) {
      return { globalCount: 0, episodeCount: 0 };
    }

    let globalCount = 0;
    let episodeCount = 0;

    if (parsed.global && typeof parsed.global === "object") {
      for (const [key, value] of Object.entries(parsed.global)) {
        if (typeof value !== "string" || value.trim().length === 0 || value.trim().length >= 500) {
          continue;
        }
        const trimmed = value.trim();
        const storageKey = normalizeFactStorageKey(key, "user");
        if (!storageKey) continue;
        upsertGlobalFact(storageKey, trimmed);
        // Also store in vector memory for semantic recall
        await remember({
          episodeId,
          sourceType: "fact",
          text: `[global] ${storageKey}: ${trimmed}`,
        });
        globalCount++;
      }
    }

    if (parsed.episode && typeof parsed.episode === "object") {
      for (const [key, value] of Object.entries(parsed.episode)) {
        if (typeof value === "string" && value.trim().length > 0 && value.trim().length < 500) {
          const trimmed = value.trim();
          const storageKey = normalizeFactStorageKey(key, "current");
          if (!storageKey) continue;
          upsertEpisodeFact(episodeId, storageKey, trimmed);
          await remember({
            episodeId,
            sourceType: "fact",
            text: `[episode] ${storageKey}: ${trimmed}`,
          });
          episodeCount++;
        }
      }
    }

    if (globalCount + episodeCount > 0) {
      logger.info({ globalCount, episodeCount, episodeId }, "facts extracted");
    }

    return { globalCount, episodeCount };
  } catch (e) {
    logger.warn({ err: e, episodeId }, "fact extraction failed (non-fatal)");
    return { globalCount: 0, episodeCount: 0 };
  }
}
