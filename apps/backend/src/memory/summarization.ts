/**
 * Episode summarization — LLM-generated episode summaries.
 * Ported from v2 src/lib/memory/summarization.ts. Per § Appendix A: "port".
 *
 * Generates a short summary of an episode's conversation, stored in
 * episodes.summary. Used by:
 *   - Reflection engine (reads summaries for context)
 *   - Episode list UI (shows summary instead of full conversation)
 *   - Context budget (summary replaces old messages when truncated)
 */

import { generateText } from "ai";
import { getChatModel } from "../llm/ollama.js";
import { listMessages } from "../services/messages.js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { episodes } from "../db/schema.js";
import { extractJson } from "../infra/prompt-safety.js";
import { logger } from "../util/logger.js";

const SUMMARIZATION_TIMEOUT_MS = 30_000;
const MAX_MESSAGES_FOR_SUMMARY = 50;
const MIN_MESSAGES_FOR_SUMMARY = 10;

const SUMMARIZATION_PROMPT = `Проанализируй диалог и создай краткое summary.

Правила:
1. 1-3 предложения, на русском.
2. Главные темы, решения, ключевые факты.
3. Без воды, без "в этом диалоге обсуждалось...".
4. Формат: JSON {"summary": "...", "title": "..."}

Диалог:
{DIALOGUE}

Summary (JSON):`;

/**
 * Generate a summary for an episode.
 * Only runs if the episode has enough messages (MIN_MESSAGES_FOR_SUMMARY).
 * Returns { summary, title } or null if skipped/failed.
 */
export async function summarizeEpisode(episodeId: string): Promise<{
  summary: string;
  title: string | null;
} | null> {
  const sqlite = getDb();
  const existing = sqlite
    .prepare("SELECT summary FROM episodes WHERE id = ?")
    .get(episodeId) as { summary: string | null } | undefined;
  if (existing?.summary) {
    return { summary: existing.summary, title: null };
  }

  const messages = listMessages(episodeId, MAX_MESSAGES_FOR_SUMMARY);

  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
    return null;
  }

  try {
    const model = await getChatModel();

    // Build dialogue text
    const dialogue = messages
      .map((m) => {
        const role = m.role === "user" ? "Пользователь" : "Лия";
        return `${role}: ${m.content.slice(0, 500)}`;
      })
      .join("\n");

    const prompt = SUMMARIZATION_PROMPT.replace("{DIALOGUE}", dialogue);

    const result = await generateText({
      model,
      system: "Ты — модуль суммаризации. Возвращай только валидный JSON.",
      prompt,
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(SUMMARIZATION_TIMEOUT_MS),
    });

    const parsed = extractJson<{ summary?: string; title?: string }>(result.text);
    if (!parsed?.summary) {
      logger.warn("summarization: failed to parse result");
      return null;
    }

    // Persist summary to episode
    const sqlite = getDb();
    const db = drizzle(sqlite);
    const now = Math.floor(Date.now() / 1000);
    const updates: Record<string, unknown> = { summary: parsed.summary, updatedAt: now };
    if (parsed.title) updates.title = parsed.title;

    db.update(episodes)
      .set(updates)
      .where(eq(episodes.id, episodeId))
      .run();

    logger.info({ episodeId, summaryPreview: parsed.summary.slice(0, 80) }, "episode summarized");
    return { summary: parsed.summary, title: parsed.title ?? null };
  } catch (e) {
    logger.warn({ err: e, episodeId }, "summarization failed (non-fatal)");
    return null;
  }
}
