/**
 * Emotional memory — significant emotional moments.
 *
 * Ported (simplified) from v2 src/lib/memory/emotional-memory.ts.
 * Per docs/ARCHITECTURE.md § 10.2.
 *
 * Stores emotional anchors: "user was frustrated about X, I supported, they thanked me."
 * Used for:
 *   - Emotional state snapshot (what user feels now, based on history)
 *   - Reflection engine (consolidation into long-term understanding)
 *
 * Decay: intensity exponentially decays (halfTime ~180 days).
 */

import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { emotionalMemories } from "../db/schema.js";
import { logger } from "../util/logger.js";
import type { EmotionVector } from "../identity/emotional-state.js";

export type EmotionalKind =
  | "frustration"
  | "joy"
  | "sadness"
  | "anger"
  | "anxiety"
  | "enthusiasm"
  | "curiosity"
  | "warmth"
  | "boredom"
  | "other";

export interface EmotionalMemoryDTO {
  id: string;
  episodeId: string;
  emotion: string;
  intensity: number;
  trigger: string;
  context: string;
  emotionVector: EmotionVector | null;
  consolidated: boolean;
  createdAt: number;
}

function makeId(): string {
  return `em_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function rowToDto(row: typeof emotionalMemories.$inferSelect): EmotionalMemoryDTO {
  return {
    id: row.id,
    episodeId: row.episodeId,
    emotion: row.emotion,
    intensity: row.intensity,
    trigger: row.trigger,
    context: row.context,
    emotionVector: row.emotionVectorJson ? (JSON.parse(row.emotionVectorJson) as EmotionVector) : null,
    consolidated: Boolean(row.consolidated),
    createdAt: row.createdAt,
  };
}

/**
 * Store an emotional memory.
 * Called after a companion turn if the perceive triggers indicate a significant
 * emotional moment (high intensity, sad topics, warmth, etc.).
 */
export function storeEmotionalMemory(params: {
  episodeId: string;
  emotion: EmotionalKind;
  intensity: number;
  trigger: string;
  context: string;
  emotionVector?: EmotionVector | null;
}): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const id = makeId();
  const now = Math.floor(Date.now() / 1000);

  db.insert(emotionalMemories)
    .values({
      id,
      episodeId: params.episodeId,
      emotion: params.emotion,
      intensity: params.intensity,
      trigger: params.trigger,
      context: params.context.slice(0, 1000),
      emotionVectorJson: params.emotionVector ? JSON.stringify(params.emotionVector) : null,
      embedding: null, // M4 will embed the context for emotional recall
      consolidated: false,
      createdAt: now,
    })
    .run();

  logger.info(
    { episodeId: params.episodeId, emotion: params.emotion, intensity: params.intensity },
    "emotional memory stored",
  );
}

/**
 * List emotional memories for an episode.
 * Returns most recent first, with decayed intensity applied.
 */
export function listEmotionalMemories(
  episodeId: string,
  opts: { limit?: number; includeConsolidated?: boolean } = {},
): EmotionalMemoryDTO[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const limit = opts.limit ?? 20;

  const condition = opts.includeConsolidated !== true
    ? and(eq(emotionalMemories.episodeId, episodeId), eq(emotionalMemories.consolidated, false))
    : eq(emotionalMemories.episodeId, episodeId);

  const rows = db
    .select()
    .from(emotionalMemories)
    .where(condition!)
    .orderBy(desc(emotionalMemories.createdAt))
    .limit(limit)
    .all();
  return rows.map(rowToDto).map(applyDecay);
}

/**
 * Get recent emotional memories across all episodes (for reflection engine).
 */
export function getRecentEmotionalMemories(limit = 50): EmotionalMemoryDTO[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select()
    .from(emotionalMemories)
    .orderBy(desc(emotionalMemories.createdAt))
    .limit(limit)
    .all();
  return rows.map(rowToDto).map(applyDecay);
}

/**
 * Format emotional memories for system prompt.
 * Shows the most significant recent emotional moments (high intensity first).
 */
export function formatEmotionalMemoriesForPrompt(memories: EmotionalMemoryDTO[]): string {
  if (memories.length === 0) return "";

  // Sort by decayed intensity, take top 3
  const sorted = [...memories].sort((a, b) => b.intensity - a.intensity).slice(0, 3);
  const lines: string[] = ["=== ЭМОЦИОНАЛЬНАЯ ПАМЯТЬ (значимые моменты) ==="];
  for (const m of sorted) {
    lines.push(`— [${m.emotion}, инт. ${m.intensity.toFixed(2)}] ${m.trigger}`);
    lines.push(`  Контекст: ${m.context.slice(0, 200)}`);
  }
  return lines.join("\n");
}

// ─── Decay (halfTime ~180 days) ───────────────────────────────────────
const DECAY_HALF_TIME_DAYS = 180;

function applyDecay(m: EmotionalMemoryDTO): EmotionalMemoryDTO {
  const ageDays = (Date.now() / 1000 - m.createdAt) / 86400;
  const factor = Math.pow(0.5, ageDays / DECAY_HALF_TIME_DAYS);
  return {
    ...m,
    intensity: m.intensity * factor,
  };
}

/**
 * Determine if a perceive result should be stored as an emotional memory.
 * Only store significant moments: high intensity, sad topics, warmth, rudeness.
 */
export function shouldStoreEmotionalMemory(
  triggers: string[],
  emotionVector: EmotionVector,
): { store: boolean; emotion: EmotionalKind; intensity: number } {
  // Sad topics → sadness memory
  if (triggers.includes("sadTopic")) {
    return { store: true, emotion: "sadness", intensity: Math.max(0.6, emotionVector.sadness) };
  }
  // Rudeness → frustration/anger memory
  if (triggers.includes("rudeness")) {
    return { store: true, emotion: "anger", intensity: Math.max(0.7, emotionVector.irritation) };
  }
  // Warmth → warmth memory (only if intensity is notable)
  if (triggers.includes("warmth") && emotionVector.joy > 0.5) {
    return { store: true, emotion: "warmth", intensity: emotionVector.joy };
  }
  // Enthusiasm → joy memory
  if (triggers.includes("enthusiasm") && emotionVector.joy > 0.6) {
    return { store: true, emotion: "joy", intensity: emotionVector.joy };
  }
  // High irritation from disagreement
  if (triggers.includes("disagreement") && emotionVector.irritation > 0.5) {
    return { store: true, emotion: "frustration", intensity: emotionVector.irritation };
  }
  return { store: false, emotion: "other", intensity: 0 };
}
