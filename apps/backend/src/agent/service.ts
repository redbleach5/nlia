/**
 * Agent task service — CRUD + lifecycle management.
 *
 * Per docs/ARCHITECTURE.md § 5.5.
 * Agent tasks are single streamText with tools, no phase-segregation.
 */

import { eq, desc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { agentTasks } from "../db/schema.js";
import { logger } from "../util/logger.js";
import type { AgentTask, AgentTaskStatus, AgentEvent } from "@lia/shared";

function makeId(): string {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function rowToDto(row: typeof agentTasks.$inferSelect): AgentTask {
  return {
    id: row.id,
    episodeId: row.episodeId,
    goal: row.goal,
    templateName: row.templateName as AgentTask["templateName"],
    status: row.status as AgentTaskStatus,
    toolsWhitelist: row.toolsWhitelist ? JSON.parse(row.toolsWhitelist) : null,
    fsScope: row.fsScope,
    maxSteps: row.maxSteps,
    maxDurationSec: row.maxDurationSec,
    currentStep: row.currentStep,
    events: JSON.parse(row.eventsJson) as AgentEvent[],
    decisionIds: JSON.parse(row.decisionIdsJson) as string[],
    resultSummary: row.resultSummary,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function createTask(params: {
  episodeId: string;
  goal: string;
  templateName?: string | null;
  toolsWhitelist?: string[] | null;
  fsScope?: string | null;
  maxSteps?: number;
  maxDurationSec?: number;
}): AgentTask {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const id = makeId();
  const now = Math.floor(Date.now() / 1000);

  db.insert(agentTasks)
    .values({
      id,
      episodeId: params.episodeId,
      goal: params.goal,
      templateName: params.templateName ?? null,
      status: "pending",
      toolsWhitelist: params.toolsWhitelist ? JSON.stringify(params.toolsWhitelist) : null,
      fsScope: params.fsScope ?? null,
      maxSteps: params.maxSteps ?? 25,
      maxDurationSec: params.maxDurationSec ?? 3600,
      currentStep: 0,
      eventsJson: "[]",
      decisionIdsJson: "[]",
      createdAt: now,
    })
    .run();

  logger.info({ taskId: id, episodeId: params.episodeId, goalPreview: params.goal.slice(0, 80) }, "agent task created");
  return getTask(id)!;
}

export function getTask(id: string): AgentTask | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db.select().from(agentTasks).where(eq(agentTasks.id, id)).get();
  return row ? rowToDto(row) : null;
}

export function listTasks(episodeId?: string, limit = 50): AgentTask[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const query = episodeId
    ? db.select().from(agentTasks).where(eq(agentTasks.episodeId, episodeId))
    : db.select().from(agentTasks);
  const rows = query.orderBy(desc(agentTasks.createdAt)).limit(limit).all();
  return rows.map(rowToDto);
}

export function updateTaskStatus(id: string, status: AgentTaskStatus, extra?: { resultSummary?: string; error?: string }): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = Math.floor(Date.now() / 1000);
  const updates: Record<string, unknown> = { status };
  if (status === "executing" && !getTask(id)?.startedAt) {
    updates.startedAt = now;
  }
  if (status === "done" || status === "failed" || status === "cancelled") {
    updates.completedAt = now;
  }
  if (extra?.resultSummary !== undefined) updates.resultSummary = extra.resultSummary;
  if (extra?.error !== undefined) updates.error = extra.error;

  db.update(agentTasks).set(updates).where(eq(agentTasks.id, id)).run();
}

/** Append an event to eventsJson + increment currentStep on tool_end. */
export function appendEvent(taskId: string, event: AgentEvent): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const task = getTask(taskId);
  if (!task) return;

  const events = [...task.events, event];
  const currentStep = event.type === "tool_end" ? task.currentStep + 1 : task.currentStep;

  db.update(agentTasks)
    .set({
      eventsJson: JSON.stringify(events),
      currentStep,
    })
    .where(eq(agentTasks.id, taskId))
    .run();
}

/** Append a decision id to decisionIdsJson. */
export function appendDecisionId(taskId: string, decisionId: string): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const task = getTask(taskId);
  if (!task) return;

  const decisionIds = [...task.decisionIds, decisionId];
  db.update(agentTasks)
    .set({ decisionIdsJson: JSON.stringify(decisionIds) })
    .where(eq(agentTasks.id, taskId))
    .run();
}

/**
 * Mark stale tasks (executing/waiting_input) as failed — called on startup
 * and lazily on GET /api/agent.
 *
 * NOTE: `pending` is intentionally NOT in the stale set. A pending task has
 * never been started — sweeping it would race with `POST /api/agent` for
 * users who create a task with `autoStart:false` and then immediately list
 * tasks. Only tasks that were actually running (executing/waiting_input)
 * when the previous server instance died should be marked failed.
 */
export function sweepStaleTasks(): number {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const staleStatuses = ["executing", "waiting_input"];
  const staleTasks = db
    .select()
    .from(agentTasks)
    .where(inArray(agentTasks.status, staleStatuses))
    .all();

  for (const task of staleTasks) {
    db.update(agentTasks)
      .set({
        status: "failed",
        error: "Task interrupted by server restart",
        completedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(agentTasks.id, task.id))
      .run();
  }

  if (staleTasks.length > 0) {
    logger.info({ count: staleTasks.length }, "swept stale agent tasks");
  }
  return staleTasks.length;
}
