/**
 * Facts service — global profile + episode-scoped context.
 *
 * Ported from v2 src/lib/memory/facts.ts (Drizzle instead of Prisma).
 * Per docs/ARCHITECTURE.md § 10.1.
 *
 * Global facts (GlobalFact): survive across episodes.
 *   user.name, user.profession, user.favorite_language, etc.
 *
 * Episode facts (EpisodeFact): erased when episode is deleted.
 *   current.project, current.task, current.topic, etc.
 */

import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { globalFacts, episodeFacts } from "../db/schema.js";
import { logger } from "../util/logger.js";

// ─── Global facts ─────────────────────────────────────────────────────

export interface GlobalFactDTO {
  key: string;
  value: string;
  confidence: number;
  hitCount: number;
}

export function getAllGlobalFacts(): GlobalFactDTO[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db.select().from(globalFacts).orderBy(globalFacts.key).all();
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    hitCount: r.hitCount,
  }));
}

export function getGlobalFact(key: string): string | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db.select().from(globalFacts).where(eq(globalFacts.key, key)).get();
  return row?.value ?? null;
}

export function upsertGlobalFact(key: string, value: string, confidence = 0.7): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = Math.floor(Date.now() / 1000);
  const existing = db.select().from(globalFacts).where(eq(globalFacts.key, key)).get();

  if (existing) {
    if (existing.value !== value) {
      // Value changed → update + reset confidence
      db.update(globalFacts)
        .set({ value, confidence, updatedAt: now })
        .where(eq(globalFacts.key, key))
        .run();
    } else {
      // Same value → bump confidence (capped at 0.95)
      db.update(globalFacts)
        .set({
          confidence: Math.min(0.95, existing.confidence + 0.1),
          updatedAt: now,
        })
        .where(eq(globalFacts.key, key))
        .run();
    }
  } else {
    try {
      db.insert(globalFacts)
        .values({ key, value, confidence, hitCount: 0, updatedAt: now })
        .run();
    } catch (e) {
      // Unique constraint — race condition; ignore
      logger.debug({ key, err: e }, "global fact upsert race (ignored)");
    }
  }
}

export function deleteGlobalFact(key: string): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  db.delete(globalFacts).where(eq(globalFacts.key, key)).run();
}

export const USER_NAME_FACT_KEY = "user.name";

export function getUserNameFromFacts(facts: GlobalFactDTO[]): string | null {
  const row = facts.find((f) => f.key === USER_NAME_FACT_KEY);
  const name = row?.value?.trim();
  return name || null;
}

// ─── Episode facts ────────────────────────────────────────────────────

export interface EpisodeFactDTO {
  key: string;
  value: string;
  createdAt: number;
}

export function getEpisodeFacts(episodeId: string, limit = 30): EpisodeFactDTO[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select()
    .from(episodeFacts)
    .where(eq(episodeFacts.episodeId, episodeId))
    .orderBy(desc(episodeFacts.createdAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    createdAt: r.createdAt,
  }));
}

export function upsertEpisodeFact(episodeId: string, key: string, value: string): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = Math.floor(Date.now() / 1000);
  const existing = db
    .select()
    .from(episodeFacts)
    .where(and(eq(episodeFacts.episodeId, episodeId), eq(episodeFacts.key, key)))
    .get();

  if (existing) {
    db.update(episodeFacts)
      .set({ value, createdAt: now })
      .where(eq(episodeFacts.id, existing.id))
      .run();
  } else {
    const id = `ef_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.insert(episodeFacts)
        .values({ id, episodeId, key, value, createdAt: now })
        .run();
    } catch (e) {
      logger.debug({ episodeId, key, err: e }, "episode fact upsert race (ignored)");
    }
  }
}

// ─── Formatters for system prompt ─────────────────────────────────────

export function formatGlobalFactsForPrompt(facts: GlobalFactDTO[]): string {
  if (facts.length === 0) return "";
  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    const prefix = f.key.split(".")[0] ?? "other";
    (grouped[prefix] ??= []).push(`${f.key}: ${f.value}`);
  }

  const lines: string[] = [];
  if (grouped.user) {
    lines.push("Собеседник:");
    for (const l of grouped.user) lines.push(`  ${l}`);
  }
  if (grouped.lia) {
    lines.push("Я (по прошлым чатам):");
    for (const l of grouped.lia) lines.push(`  ${l}`);
  }
  const otherKeys = Object.keys(grouped).filter((k) => k !== "user" && k !== "lia");
  if (otherKeys.length > 0) {
    lines.push("Прочее:");
    for (const k of otherKeys) {
      for (const l of grouped[k]) lines.push(`  ${l}`);
    }
  }
  return lines.join("\n");
}

export function formatEpisodeFactsForPrompt(facts: EpisodeFactDTO[]): string {
  if (facts.length === 0) return "";
  return facts
    .filter((f) => f.value.trim().length > 0)
    .map((f) => `${f.key}: ${f.value}`)
    .join("\n");
}
