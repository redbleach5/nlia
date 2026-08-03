import 'server-only';

// AgentTask — CRUD для агентских задач.

import { db } from '@/lib/db';
import { randomUUID } from 'crypto';
import { displayAgentGoal, extractLegacyTemplateOverlay } from './goal-display';
import { getTemplate } from './templates';

export type AgentTaskStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'waiting_input'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export const AGENT_TRANSIENT_STATUSES = [
  'planning',
  'executing',
  'waiting_input',
  'synthesizing',
] as const satisfies readonly AgentTaskStatus[];

export type AgentTask = {
  id: string;
  episodeId: string;
  /** User-facing goal only (never template system prompt). */
  goal: string;
  /** Preset name; overlay resolved into LLM system channel. */
  templateName: string | null;
  /** Template / legacy instructions for LLM system — not for UI. */
  systemOverlay: string;
  status: AgentTaskStatus;
  planJson: string | null;
  currentStep: number;
  stepsJson: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  maxSteps: number;
  maxDurationSec: number;
  toolsWhitelist: string | null;
  fsScope: string | null;
  checkpointJson: string | null;
  resultSummary: string | null;
  artifactsJson: string;
};

export type CreateAgentTaskInput = {
  episodeId: string;
  goal: string;
  templateName?: string | null;
  toolsWhitelist?: string[] | null;
  fsScope?: string | null;
  maxSteps?: number;
  maxDurationSec?: number;
};

export async function createAgentTask(input: CreateAgentTaskInput): Promise<AgentTask> {
  const templateName = input.templateName && input.templateName !== 'general'
    ? input.templateName
    : null;
  const task = await db.agentTask.create({
    data: {
      id: randomUUID(),
      episodeId: input.episodeId,
      goal: displayAgentGoal(input.goal),
      status: 'pending',
      maxSteps: input.maxSteps ?? 15,
      maxDurationSec: input.maxDurationSec ?? 600,
      toolsWhitelist: input.toolsWhitelist ? JSON.stringify(input.toolsWhitelist) : null,
      fsScope: input.fsScope ?? null,
      stepsJson: '[]',
      artifactsJson: '[]',
    },
  });
  // templateName is additive (schema patch); write via SQL so older Prisma
  // clients still work before `prisma generate` unlocks.
  if (templateName) {
    try {
      await db.$executeRawUnsafe(
        'UPDATE "AgentTask" SET "templateName" = ? WHERE "id" = ?',
        templateName,
        task.id,
      );
    } catch (e) {
      // Column missing until db:patch — non-fatal; overlay falls back to none.
    }
  }
  return toAgentTask({ ...task, templateName });
}

export async function getAgentTask(id: string): Promise<AgentTask | null> {
  const task = await db.agentTask.findUnique({ where: { id } });
  if (!task) return null;
  const templateName = await readTemplateName(id);
  return toAgentTask({ ...task, templateName });
}

export async function listAgentTasks(
  episodeId?: string,
  limit = 50,
): Promise<AgentTask[]> {
  const tasks = await db.agentTask.findMany({
    where: episodeId ? { episodeId } : {},
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const names = await readTemplateNames(tasks.map(t => t.id));
  return tasks.map(t => toAgentTask({ ...t, templateName: names.get(t.id) ?? null }));
}

async function readTemplateName(id: string): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ templateName: string | null }>>(
      'SELECT "templateName" AS templateName FROM "AgentTask" WHERE "id" = ? LIMIT 1',
      id,
    );
    return rows[0]?.templateName ?? null;
  } catch {
    return null;
  }
}

async function readTemplateNames(ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.$queryRawUnsafe<Array<{ id: string; templateName: string | null }>>(
      `SELECT "id" AS id, "templateName" AS templateName FROM "AgentTask" WHERE "id" IN (${placeholders})`,
      ...ids,
    );
    for (const r of rows) map.set(r.id, r.templateName ?? null);
  } catch {
    /* column missing */
  }
  return map;
}

export async function updateAgentTask(id: string, params: Partial<{
  status: AgentTaskStatus;
  planJson: string | null;
  currentStep: number;
  maxSteps: number;
  stepsJson: string;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  checkpointJson: string | null;
  resultSummary: string | null;
  artifactsJson: string;
}>): Promise<AgentTask | null> {
  try {
    const task = await db.agentTask.update({
      where: { id },
      data: params,
    });
    return toAgentTask(task);
  } catch {
    return null;
  }
}

function toAgentTask(row: {
  id: string;
  episodeId: string;
  goal: string;
  templateName?: string | null;
  status: string;
  planJson: string | null;
  currentStep: number;
  stepsJson: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  maxSteps: number;
  maxDurationSec: number;
  toolsWhitelist: string | null;
  fsScope: string | null;
  checkpointJson: string | null;
  resultSummary: string | null;
  artifactsJson: string;
}): AgentTask {
  const rawGoal = row.goal;
  const templateName = row.templateName ?? null;
  const systemOverlay = templateName
    ? getTemplate(templateName).systemPrompt
    : extractLegacyTemplateOverlay(rawGoal);

  return {
    id: row.id,
    episodeId: row.episodeId,
    goal: displayAgentGoal(rawGoal),
    templateName,
    systemOverlay,
    status: row.status as AgentTaskStatus,
    planJson: row.planJson,
    currentStep: row.currentStep,
    stepsJson: row.stepsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    maxSteps: row.maxSteps,
    maxDurationSec: row.maxDurationSec,
    toolsWhitelist: row.toolsWhitelist,
    fsScope: row.fsScope,
    checkpointJson: row.checkpointJson,
    resultSummary: row.resultSummary,
    artifactsJson: row.artifactsJson,
  };
}

export function parseSteps(stepsJson: string): Array<{
  thought: string;
  action: string;
  input: unknown;
  observation: string;
  ts: number;
  durationMs: number;
}> {
  try {
    const parsed = JSON.parse(stepsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export type AgentArtifactEntry = {
  kind: string;
  path: string;
  meta?: Record<string, unknown>;
};

export function parseArtifacts(artifactsJson: string): AgentArtifactEntry[] {
  try {
    const parsed = JSON.parse(artifactsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export async function appendAgentTaskArtifact(
  taskId: string,
  entry: AgentArtifactEntry,
): Promise<void> {
  const row = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { artifactsJson: true },
  });
  if (!row) return;
  const artifacts = parseArtifacts(row.artifactsJson);
  artifacts.push(entry);
  await db.agentTask.update({
    where: { id: taskId },
    data: { artifactsJson: JSON.stringify(artifacts) },
  });
}

export function formatOpenTasksForPrompt(tasks: AgentTask[]): string {
  const active = tasks.filter(t =>
    t.status === 'pending' || t.status === 'planning' || t.status === 'executing' ||
    t.status === 'waiting_input' || t.status === 'synthesizing'
  );
  if (active.length === 0) return '';
  return active.map(t => `- [${t.status}] ${t.goal} (шаг ${t.currentStep}/${t.maxSteps})`).join('\n');
}
