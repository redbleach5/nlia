/**
 * Episodes service — CRUD + ensure-default.
 *
 * Per docs/ARCHITECTURE.md § 5.1 + § 13.3. Ported from v2 src/lib/memory/episodes.ts
 * with Drizzle instead of Prisma.
 *
 * Episode isolation is the architectural invariant: every message, fact, vector
 * and emotional memory is scoped to episode_id. No cross-episode leaks.
 */

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { episodes, messages } from "../db/schema.js";
import { logger } from "../util/logger.js";
import type { Episode, EpisodeListItem, EpisodeMode } from "@lia/shared";

// Generate a CUID-like id (compact, url-safe, no dep on cuid lib).
function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`;
}

function toDto(row: typeof episodes.$inferSelect): Episode {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as EpisodeMode,
    isDefault: Boolean(row.isDefault),
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

/** List episodes, most-recently-active first. Includes message count. */
export function listEpisodes(limit = 50): EpisodeListItem[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select({
      id: episodes.id,
      title: episodes.title,
      mode: episodes.mode,
      isDefault: episodes.isDefault,
      summary: episodes.summary,
      createdAt: episodes.createdAt,
      updatedAt: episodes.updatedAt,
      endedAt: episodes.endedAt,
      lastMessageAt: episodes.lastMessageAt,
      messageCount: sql<number>`(SELECT COUNT(*) FROM ${messages} WHERE ${messages.episodeId} = ${episodes.id})`.as("message_count"),
    })
    .from(episodes)
    .orderBy(desc(episodes.updatedAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    ...toDto(r),
    messageCount: r.messageCount ?? 0,
  }));
}

/** Get one episode by id. */
export function getEpisode(id: string): Episode | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db.select().from(episodes).where(eq(episodes.id, id)).get();
  return row ? toDto(row) : null;
}

/** Create a new episode. */
export function createEpisode(opts?: { title?: string | null; mode?: EpisodeMode; isDefault?: boolean }): Episode {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const id = makeId();
  const now = Math.floor(Date.now() / 1000);
  db.insert(episodes)
    .values({
      id,
      title: opts?.title ?? null,
      mode: opts?.mode ?? "chat",
      isDefault: opts?.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  logger.info({ episodeId: id, title: opts?.title ?? null }, "episode created");
  return getEpisode(id)!;
}

/**
 * Atomically create the default episode if none exists. Idempotent.
 *
 * Solves the race in v2 where two parallel GET /api/episodes both saw 0
 * episodes and both POST'd, producing 2 empty chats.
 */
export function ensureDefaultEpisode(): { created: boolean; episodeId: string | null; episodes: EpisodeListItem[] } {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const tx = sqlite.transaction(() => {
    const count = db.select({ c: sql<number>`count(*)` }).from(episodes).get();
    if ((count?.c ?? 0) === 0) {
      const created = createEpisode({ title: null, isDefault: true });
      return { created: true, episodeId: created.id };
    }
    return { created: false, episodeId: null };
  });
  const result = tx();
  return { ...result, episodes: listEpisodes(500) };
}

/** Delete an episode. Cascades to messages, facts, memories (FK onDelete: cascade). */
export function deleteEpisode(id: string): boolean {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const result = db.delete(episodes).where(eq(episodes.id, id)).run();
  return (result.changes ?? 0) > 0;
}

/** Update episode's updatedAt + lastMessageAt after a new message. */
export function touchEpisode(episodeId: string, atSeconds?: number): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = atSeconds ?? Math.floor(Date.now() / 1000);
  db.update(episodes)
    .set({ updatedAt: now, lastMessageAt: now })
    .where(eq(episodes.id, episodeId))
    .run();
}

/** Rename an episode. */
export function renameEpisode(id: string, title: string): Episode | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = Math.floor(Date.now() / 1000);
  db.update(episodes)
    .set({ title, updatedAt: now })
    .where(eq(episodes.id, id))
    .run();
  return getEpisode(id);
}

/** Find any default episodes (used internally to clear old default before setting new). */
export function clearDefaultFlag(): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  db.update(episodes)
    .set({ isDefault: false })
    .where(eq(episodes.isDefault, true))
    .run();
}
