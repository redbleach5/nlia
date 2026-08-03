/**
 * Episode title generation — auto-generate a title from first messages.
 * Ported from v2 src/lib/memory/episode-title.ts. Per § Appendix A: "port".
 */

import { generateText } from "ai";
import { getChatModel } from "../llm/ollama.js";
import { listMessages } from "../services/messages.js";
import { getEpisode, renameEpisode } from "../services/episodes.js";
import { logger } from "../util/logger.js";

const TITLE_TIMEOUT_MS = 10_000;

/**
 * Auto-generate a title for an episode based on its first few messages.
 * Only runs if the episode has no title yet.
 */
export async function generateEpisodeTitle(episodeId: string): Promise<string | null> {
  const episode = getEpisode(episodeId);
  if (!episode) return null;
  if (episode.title && episode.title.trim()) return episode.title;

  const messages = listMessages(episodeId, 5);
  if (messages.length === 0) return null;

  try {
    const model = await getChatModel();
    const dialogue = messages
      .map((m) => `${m.role === "user" ? "П" : "Л"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const result = await generateText({
      model,
      system: "Сгенерируй короткий заголовок (2-5 слов) для диалога. Только заголовок, без кавычек.",
      prompt: dialogue,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });

    let title = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 100);
    if (!title) return null;

    renameEpisode(episodeId, title);
    logger.info({ episodeId, title }, "episode title generated");
    return title;
  } catch (e) {
    logger.warn({ err: e, episodeId }, "title generation failed (non-fatal)");
    return null;
  }
}
