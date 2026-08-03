/**
 * CodingIntent — shared plan shape for ReAct + Claude Code.
 * Pure helpers here; brief I/O uses workspace memory (server).
 */

import { createHash } from 'crypto';
import { resolve } from 'path';

export const MAX_TARGET_FILES = 20;
export const MAX_BRIEF_CHARS = 400;
/** Workspace memory shortKey for last coding task brief. */
export const CODING_LAST_BRIEF_KEY = 'coding.lastBrief';

export type CodingComplexity = 'low' | 'medium' | 'high';

export type CodingIntent = {
  goal: string;
  steps: string[];
  targetFiles: string[];
  complexity: CodingComplexity;
  needsTools: boolean;
  /** Prior task brief loaded at start (not persisted inside planJson). */
  brief?: string;
};

function normalizePathKey(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Fingerprint from fsScope alone (project or sandbox path). */
export function fingerprintFromFsScope(fsScope: string | null | undefined): string | null {
  if (!fsScope?.trim()) return null;
  const kind = /agent-workspaces[/\\]/i.test(fsScope) ? 's' : 'p';
  const h = createHash('sha256').update(`${kind}:${normalizePathKey(fsScope)}`).digest('hex');
  return `${kind}_${h.slice(0, 12)}`;
}

/** Normalize / cap relative paths for plan.targetFiles. */
export function normalizeTargetFiles(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    let p = raw.trim().replace(/\\/g, '/');
    if (!p || p.includes('\0')) continue;
    // Reject absolute / escape attempts in the plan list (display + prompt only).
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('..')) continue;
    p = p.replace(/^\.\//, '').slice(0, 240);
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_TARGET_FILES) break;
  }
  return out;
}

export function mergeTargetFiles(existing: string[], incoming: string[]): string[] {
  return normalizeTargetFiles([...existing, ...incoming]);
}

export function buildCodingIntentFromPlan(
  plan: {
    goal: string;
    steps: string[];
    needsTools?: boolean;
    complexity?: string;
    targetFiles?: string[];
  },
  opts?: { brief?: string },
): CodingIntent {
  const complexity: CodingComplexity =
    plan.complexity === 'low' || plan.complexity === 'high' ? plan.complexity : 'medium';
  const brief = opts?.brief?.trim().slice(0, MAX_BRIEF_CHARS);
  return {
    goal: plan.goal || 'Выполнить задачу',
    steps: Array.isArray(plan.steps) ? plan.steps.map(String) : [],
    targetFiles: normalizeTargetFiles(plan.targetFiles),
    complexity,
    needsTools: plan.needsTools !== false,
    ...(brief ? { brief } : {}),
  };
}

/** Build a short operational brief (no companion voice). */
export function buildCodingTaskBrief(input: {
  goal: string;
  summary: string;
  files: string[];
  unfinished?: string;
}): string {
  const files = normalizeTargetFiles(input.files).slice(0, 12).join(', ') || '(нет)';
  const parts = [
    `Goal: ${input.goal.trim().slice(0, 120)}`,
    `Done: ${input.summary.trim().slice(0, 180)}`,
    `Files: ${files}`,
  ];
  if (input.unfinished?.trim()) {
    parts.push(`Open: ${input.unfinished.trim().slice(0, 80)}`);
  }
  return parts.join('\n').slice(0, MAX_BRIEF_CHARS);
}

export function formatCodingBriefForPrompt(brief: string): string {
  const t = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (!t) return '';
  return `Previous coding task in this workspace (facts only, do not invent beyond this):\n${t}`;
}
