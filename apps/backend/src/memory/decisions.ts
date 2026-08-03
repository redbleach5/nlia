/**
 * Decision log — model reasoning trace.
 *
 * Per docs/ARCHITECTURE.md § 5.3 + § 10.4.
 *
 * Does NOT replace episodic memory (that's about the user) — decisions are
 * about Lia herself: what she decided, why, and what the outcome was.
 *
 * M3: creates the table + CRUD service. Auto-write in chat pipeline's
 * onStepFinish happens when the model makes an explicit decision (M5 agent
 * uses this heavily; M3 chat can write decisions for significant turns).
 */

import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { logger } from "../util/logger.js";

export type DecisionModelRole = "day" | "heavy" | "agent";

export interface DecisionDTO {
  id: string;
  taskId: string | null;
  episodeId: string;
  ts: number;
  situation: string;
  options: string[];
  chosen: string;
  rationale: string;
  outcome: string | null;
  modelRole: DecisionModelRole;
}

function makeId(): string {
  return `dec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function rowToDto(row: typeof decisions.$inferSelect): DecisionDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    episodeId: row.episodeId,
    ts: row.ts,
    situation: row.situation,
    options: JSON.parse(row.options) as string[],
    chosen: row.chosen,
    rationale: row.rationale,
    outcome: row.outcome,
    modelRole: row.modelRole as DecisionModelRole,
  };
}

/**
 * Create a decision record.
 */
export function createDecision(params: {
  episodeId: string;
  taskId?: string | null;
  situation: string;
  options: string[];
  chosen: string;
  rationale: string;
  modelRole: DecisionModelRole;
}): DecisionDTO {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const id = makeId();
  const now = Math.floor(Date.now() / 1000);

  db.insert(decisions)
    .values({
      id,
      taskId: params.taskId ?? null,
      episodeId: params.episodeId,
      ts: now,
      situation: params.situation,
      options: JSON.stringify(params.options),
      chosen: params.chosen,
      rationale: params.rationale,
      modelRole: params.modelRole,
    })
    .run();

  logger.info(
    { episodeId: params.episodeId, chosen: params.chosen, role: params.modelRole },
    "decision recorded",
  );
  return getDecision(id)!;
}

/**
 * Get a single decision by id.
 */
export function getDecision(id: string): DecisionDTO | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db.select().from(decisions).where(eq(decisions.id, id)).get();
  return row ? rowToDto(row) : null;
}

/**
 * List decisions for an episode (most recent first).
 */
export function listDecisions(
  episodeId: string,
  opts: { limit?: number; taskId?: string } = {},
): DecisionDTO[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const limit = opts.limit ?? 20;

  let rows;
  if (opts.taskId) {
    rows = db
      .select()
      .from(decisions)
      .where(and(eq(decisions.episodeId, episodeId), eq(decisions.taskId, opts.taskId)))
      .orderBy(desc(decisions.ts))
      .limit(limit)
      .all();
  } else {
    rows = db
      .select()
      .from(decisions)
      .where(eq(decisions.episodeId, episodeId))
      .orderBy(desc(decisions.ts))
      .limit(limit)
      .all();
  }
  return rows.map(rowToDto);
}

/**
 * Update the outcome of a decision (filled in when result is known).
 */
export function updateDecisionOutcome(id: string, outcome: string): DecisionDTO | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  db.update(decisions)
    .set({ outcome })
    .where(eq(decisions.id, id))
    .run();
  return getDecision(id);
}

/**
 * Format recent decisions for system prompt (for agent loop context).
 * M5 agent reads this when in a loop to avoid repeating decisions.
 */
export function formatDecisionsForPrompt(ds: DecisionDTO[]): string {
  if (ds.length === 0) return "";
  const lines: string[] = ["=== ЖУРНАЛ РЕШЕНИЙ (мои недавние решения) ==="];
  for (const d of ds.slice(0, 5)) {
    lines.push(`— Ситуация: ${d.situation.slice(0, 150)}`);
    lines.push(`  Решила: ${d.chosen} (${d.rationale.slice(0, 100)})`);
    if (d.outcome) {
      lines.push(`  Результат: ${d.outcome.slice(0, 100)}`);
    }
  }
  return lines.join("\n");
}
