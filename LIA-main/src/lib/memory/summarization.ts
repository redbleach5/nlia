import 'server-only';

// ============================================================================
// Conversation summarization — compress long episodes into a summary.
// ============================================================================
//
// Problem: Long episodes (>50 messages) overflow the context window. Currently
// we truncate by maxMessages — losing early context that may be important.
//
// Solution: Every N messages (default 20), the LLM generates a summary of the
// conversation so far. The summary is stored in Episode.summary and injected
// into the system prompt instead of the full message history.
//
// Flow:
//   1. After each user message, check if Message count for the episode
//      crossed a threshold (e.g. 20, 40, 60...).
//   2. If yes, fire summarizeEpisode(episodeId) in background.
//   3. LLM gets the last 30 messages + current summary (if any) and produces
//      an updated 1-paragraph summary.
//   4. Summary is stored in Episode.summary.
//   5. In pipeline.ts, if Episode.summary exists, it's injected into the
//      system prompt as "Previous conversation context".
//
// Cost: 1 LLM call per 20 messages. For a 100-message chat = 5 calls total.
// Negligible vs the 100 main streamText calls.

import { generateText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const SUMMARIZE_EVERY_N_MESSAGES = 20;
/** Faster cadence when dialogue budget is dropping older turns. */
const SUMMARIZE_UNDER_PRESSURE_EVERY = 8;
const MAX_MESSAGES_FOR_SUMMARY = 30;  // last N messages sent to LLM
const MAX_SUMMARY_CHARS = 1500;
const LLM_TIMEOUT_MS = 60_000;

/**
 * Check if an episode needs summarization based on message count.
 *
 * Returns true if message count crossed the next SUMMARIZE_EVERY_N_MESSAGES
 * boundary since the last summary (or since episode start if no summary yet).
 *
 * Used by pipeline.ts to decide whether to fire summarizeEpisode() in
 * background after a user message.
 *
 * @param opts.budgetPressured — when dialogue budget dropped older turns,
 *   re-summarize every SUMMARIZE_UNDER_PRESSURE_EVERY messages instead of 20.
 */
export async function shouldSummarizeEpisode(
  episodeId: string,
  opts?: { budgetPressured?: boolean },
): Promise<boolean> {
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: {
      summary: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  if (!episode) return false;

  const messageCount = episode._count.messages;
  const interval = opts?.budgetPressured
    ? SUMMARIZE_UNDER_PRESSURE_EVERY
    : SUMMARIZE_EVERY_N_MESSAGES;

  if (!episode.summary) {
    return messageCount >= interval;
  }

  const match = episode.summary.match(/^\[summarized@(\d+)\]/);
  const lastSummarizedAt = match ? parseInt(match[1], 10) : 0;
  return messageCount >= lastSummarizedAt + interval;
}

/**
 * Generate or update the episode summary.
 *
 * Reads the last MAX_MESSAGES_FOR_SUMMARY messages + existing summary (if any),
 * asks LLM to produce an updated summary, persists it to Episode.summary.
 *
 * Format: `[summarized@<messageCount>] <summary text>` — the prefix lets
 * shouldSummarizeEpisode() know when to re-summarize next.
 *
 * Non-throwing: errors are logged, original summary is kept.
 */
export async function summarizeEpisode(episodeId: string): Promise<void> {
  try {
    // P-CORE-1 fix: previously `orderBy: asc` + `take: N` returned the OLDEST
    // N messages — the prompt said "ПОСЛЕДНИЕ СООБЩЕНИЯ" but the code did the
    // opposite. For a 100-message episode the summary was built on messages
    // 1-30 and missed the recent context entirely. Now we fetch the newest N
    // (desc) and reverse them back to chronological order for the prompt.
    const episode = await db.episode.findUnique({
      where: { id: episodeId },
      select: {
        id: true,
        summary: true,
        messages: {
          select: { role: true, content: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_MESSAGES_FOR_SUMMARY,
          skip: 0,
        },
      },
    });
    if (!episode) return;
    // Allow summarization once we have enough recent messages to be useful
    // (pressure path may fire before the normal every-20 cadence).
    if (episode.messages.length < SUMMARIZE_UNDER_PRESSURE_EVERY) return;

    // Reverse to chronological (oldest first, newest last) for the prompt.
    const recentMessages = episode.messages.slice().reverse();

    // Strip the [summarized@N] prefix from existing summary
    const existingSummary = episode.summary
      ? episode.summary.replace(/^\[summarized@\d+\]\s*/, '')
      : null;

    const messageBlock = recentMessages
      .map(m => `${m.role === 'user' ? 'Пользователь' : m.role === 'companion' ? 'Лия' : m.role}: ${m.content.slice(0, 400)}`)
      .join('\n');

    const prompt = `Ты — ассистент, который делает краткое саммари диалога. Сохрани важный контекст: темы, решения, факты, предпочтения пользователя.

${existingSummary ? `ТЕКУЩЕЕ САММАРИ:\n${existingSummary}\n\n` : ''}ПОСЛЕДНИЕ СООБЩЕНИЯ (${recentMessages.length}):
${messageBlock}

Дай обновлённое саммари в 1-2 абзацах (до ${MAX_SUMMARY_CHARS} символов). На русском. Без воды, только значимый контекст. Не используй фразы вроде "в этом диалоге" — пиши прямо о сути.`;

    const model = await getChatModel();
    const result = await generateText({
      model,
      prompt,
      temperature: 0.3,
      maxOutputTokens: 500,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const summary = result.text.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) {
      logger.warn('chat', 'Episode summarization: empty result', { episodeId: episodeId.slice(0, 8) });
      return;
    }

    // Get current total message count for the prefix
    const countResult = await db.episode.findUnique({
      where: { id: episodeId },
      select: { _count: { select: { messages: true } } },
    });
    const totalCount = countResult?._count.messages ?? episode.messages.length;
    const prefixedSummary = `[summarized@${totalCount}] ${summary}`;

    await db.episode.update({
      where: { id: episodeId },
      data: { summary: prefixedSummary },
    });

    logger.info('chat', 'Episode summarized', {
      episodeId: episodeId.slice(0, 8),
      messageCount: totalCount,
      summaryLength: summary.length,
    });
  } catch (e) {
    logger.warn('chat', 'Episode summarization failed (non-fatal)', {
      episodeId: episodeId.slice(0, 8),
    }, e);
  }
}

/**
 * Get the summary for an episode (without the [summarized@N] prefix).
 * Returns null if no summary exists.
 */
export async function getEpisodeSummary(episodeId: string): Promise<string | null> {
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: { summary: true },
  });
  if (!episode?.summary) return null;
  return episode.summary.replace(/^\[summarized@\d+\]\s*/, '');
}
