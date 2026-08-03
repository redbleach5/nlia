import 'server-only';

// Episodes — CRUD for chat threads.
//
// Каждый эпизод = отдельный чат. Память привязана к эпизоду:
//   - EpisodeFact — контекстные факты (только этот чат)
//   - VectorMemory — векторная память (только этот чат)
//   - Message — сообщения (только этот чат)
//
// Глобально (переживает смену чата) только GlobalFact — профиль пользователя.

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { escapeForPrompt } from '@/lib/infra/prompt-safety';

export type Episode = {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  messageCount: number;
  /** Truncated latest message content for sidebar preview. */
  preview: string | null;
};

function previewFromContent(content: string | undefined | null): string | null {
  if (!content) return null;
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79)}…`;
}

export async function createEpisode(title?: string): Promise<Episode> {
  const ep = await db.episode.create({
    data: title ? { title } : {},
  });
  return {
    id: ep.id,
    title: ep.title,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
    endedAt: ep.endedAt,
    summary: ep.summary,
    messageCount: 0,
    preview: null,
  };
}

export async function listEpisodes(limit = 50): Promise<Episode[]> {
  const episodes = await db.episode.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
  });
  return episodes.map(e => ({
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    endedAt: e.endedAt,
    summary: e.summary,
    messageCount: e._count.messages,
    preview: previewFromContent(e.messages[0]?.content),
  }));
}

export async function getEpisode(id: string): Promise<Episode | null> {
  const ep = await db.episode.findUnique({
    where: { id },
    include: {
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
  });
  if (!ep) return null;
  return {
    id: ep.id,
    title: ep.title,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
    endedAt: ep.endedAt,
    summary: ep.summary,
    messageCount: ep._count.messages,
    preview: previewFromContent(ep.messages[0]?.content),
  };
}

export async function renameEpisode(id: string, title: string): Promise<void> {
  await db.episode.update({
    where: { id },
    data: { title: title.slice(0, 200) },
  });
}

export async function deleteEpisode(id: string): Promise<void> {
  // Clean raw-SQL vector index (vec_virtual + vec_rowid_map) BEFORE Prisma delete.
  // Prisma cascade handles VectorMemory, EmotionalMemory, etc., but NOT the
  // raw vec0 virtual table and mapping table (they're outside Prisma's schema).
  try {
    const { deleteVectorsInEpisode } = await import('@/lib/db-vec');
    deleteVectorsInEpisode(id);
  } catch (e) {
    // Non-fatal — Prisma cascade will still clean VectorMemory rows,
    // but vec_virtual/vec_rowid_map orphans may remain.
    logger.warn('memory', 'deleteVectorsInEpisode failed (non-fatal)', {}, e);
  }

  try {
    await db.episode.delete({ where: { id } });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'P2025') return; // already deleted
    throw e;
  }

  try {
    const { deleteEpisodeChatAttachmentFiles } = await import('@/lib/chat/attachments');
    await deleteEpisodeChatAttachmentFiles(id);
  } catch (e) {
    logger.warn('memory', 'deleteEpisodeChatAttachmentFiles failed (non-fatal)', {}, e);
  }
}

// ============================================================================
// Messages
// ============================================================================
export type ChatMessage = {
  id: string;
  episodeId: string;
  role: 'user' | 'companion' | 'tool' | 'system';
  content: string;
  emotionJson: string | null;
  toolCallsJson: string | null;
  attachmentsJson: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  createdAt: Date;
};

export async function saveMessage(episodeId: string, params: {
  role: 'user' | 'companion' | 'tool' | 'system';
  content: string;
  emotionJson?: string | null;
  toolCallsJson?: string | null;
  attachmentsJson?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
}): Promise<ChatMessage> {
  const msg = await db.message.create({
    data: {
      episodeId,
      role: params.role,
      content: params.content,
      emotionJson: params.emotionJson,
      toolCallsJson: params.toolCallsJson,
      attachmentsJson: params.attachmentsJson,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      durationMs: params.durationMs,
    },
  });
  return {
    id: msg.id,
    episodeId: msg.episodeId,
    role: msg.role as ChatMessage['role'],
    content: msg.content,
    emotionJson: msg.emotionJson,
    toolCallsJson: msg.toolCallsJson,
    attachmentsJson: msg.attachmentsJson,
    tokensIn: msg.tokensIn,
    tokensOut: msg.tokensOut,
    durationMs: msg.durationMs,
    createdAt: msg.createdAt,
  };
}

/**
 * Get messages for an episode — cursor-based pagination.
 *
 * Phase 7.1: добавлена поддержка cursor для загрузки истории по частям.
 * При вызове без cursor — возвращает последние `limit` сообщений (как раньше).
 * При вызове с cursor (createdAtolder) — возвращает `limit` сообщений
 * старше cursor, для подгрузки истории при скролле вверх.
 *
 * Возвращает сообщения в хронологическом порядке (старые → новые).
 */
export async function getMessages(
  episodeId: string,
  limit = 50,
  cursor?: { createdAt: Date; id: string },
): Promise<ChatMessage[]> {
  // P1-3 fix (H-MEM-4): composite cursor to handle tied timestamps.
  // Previous code only filtered `createdAt < cursor.createdAt` — if two
  // messages shared the same createdAt (ms precision, possible on fast
  // machines), the message at cursor.createdAt with id > cursor.id was
  // skipped forever.
  const rows = await db.message.findMany({
    where: {
      episodeId,
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return rows.reverse().map(r => ({
    id: r.id,
    episodeId: r.episodeId,
    role: r.role as ChatMessage['role'],
    content: r.content,
    emotionJson: r.emotionJson,
    toolCallsJson: r.toolCallsJson,
    attachmentsJson: r.attachmentsJson,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  }));
}

/**
 * Auto-derive a title from the first user message.
 * Called after the first message in an untitled episode.
 */
export async function autoTitleEpisode(episodeId: string, firstUserMessage: string): Promise<string | null> {
  try {
    // P1-3 fix (H-MEM-5): atomic conditional update.
    // Previous code did find-then-update — two concurrent calls (rapid messages)
    // both read title=null, both write. Last wins, wasted writes.
    // Now we use updateMany with where: { title: null } — only updates if
    // title is still null. Atomic at the DB level.
    const { deriveEpisodeTitle } = await import('@/lib/memory/episode-title');
    const title = deriveEpisodeTitle(firstUserMessage);
    if (!title) return null;

    const result = await db.episode.updateMany({
      where: { id: episodeId, title: null },
      data: { title },
    });

    if (result.count === 0) {
      // Title was already set by a concurrent call — fetch the existing one.
      const ep = await db.episode.findUnique({ where: { id: episodeId }, select: { title: true } });
      return ep?.title ?? null;
    }
    return title;
  } catch {
    return null;
  }
}

/**
 * H-MEM-1: episode summary is derived from dialogue — escape before system-prompt inject.
 * Strips internal `[summarized@N]` marker used by rolling summarization.
 */
export function formatEpisodeSummaryForPrompt(summary: string | null | undefined): string {
  if (!summary) return '';
  const cleaned = summary.replace(/^\[summarized@\d+\]\s*/, '');
  if (!cleaned) return '';
  return escapeForPrompt(cleaned, { label: 'summary' });
}
