/**
 * Prompt helpers — fact loading + formatting for system prompt.
 *
 * Separated from facts.ts to avoid circular dependencies between
 * facts.ts → vector.ts → ollama.ts and system-prompt.ts → facts.ts.
 */

import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { globalFacts, episodeFacts } from "../db/schema.js";
import type { GlobalFactDTO, EpisodeFactDTO } from "./facts.js";

export function loadGlobalFacts(): GlobalFactDTO[] {
  try {
    const sqlite = getDb();
    const db = drizzle(sqlite);
    const rows = db.select().from(globalFacts).orderBy(globalFacts.key).all();
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      hitCount: r.hitCount,
    }));
  } catch {
    return [];
  }
}

export function loadEpisodeFacts(episodeId: string): EpisodeFactDTO[] {
  try {
    const sqlite = getDb();
    const db = drizzle(sqlite);
    const rows = db
      .select()
      .from(episodeFacts)
      .where(eq(episodeFacts.episodeId, episodeId))
      .orderBy(desc(episodeFacts.createdAt))
      .limit(30)
      .all();
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      createdAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}

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
