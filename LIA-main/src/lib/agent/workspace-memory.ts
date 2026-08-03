import 'server-only';

/**
 * Workspace memory — GlobalFact keys `workspace.<fingerprint>.*`
 * Survive episode switches when the same project/KB is pinned again.
 */

import { createHash } from 'crypto';
import { readdir } from 'fs/promises';
import { resolve } from 'path';
import { db } from '@/lib/db';
import {
  getAllGlobalFacts,
  upsertGlobalFact,
  deleteGlobalFact,
} from '@/lib/memory/facts';
import { escapeForPrompt } from '@/lib/infra/prompt-safety';
import { logger } from '@/lib/logger';
import type { WorkspaceBinding } from './workspace-types';

export const WORKSPACE_MEMORY_PREFIX = 'workspace.';
export const MAX_WORKSPACE_FACTS = 12;
export const MAX_WORKSPACE_PROMPT_CHARS = 900;

export type WorkspaceMemoryFact = {
  key: string;
  /** Short key without `workspace.<fp>.` prefix */
  shortKey: string;
  value: string;
};

function normalizePathKey(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Stable id for a binding — same project/KB → same fingerprint across episodes. */
export function workspaceFingerprint(binding: WorkspaceBinding | null | undefined): string | null {
  if (!binding || binding.kind === 'none') return null;

  if (binding.kind === 'project' && binding.fsPath) {
    const h = createHash('sha256').update(`p:${normalizePathKey(binding.fsPath)}`).digest('hex');
    return `p_${h.slice(0, 12)}`;
  }

  if (binding.kind === 'kb' && binding.sourceIds.length > 0) {
    const ids = binding.sourceIds.slice().sort().join(',');
    const h = createHash('sha256').update(`k:${ids}`).digest('hex');
    return `k_${h.slice(0, 12)}`;
  }

  // Sandbox is ephemeral — still allow per-path memory within the same tree
  if (binding.kind === 'sandbox' && binding.fsPath) {
    const h = createHash('sha256').update(`s:${normalizePathKey(binding.fsPath)}`).digest('hex');
    return `s_${h.slice(0, 12)}`;
  }

  return null;
}

export function workspaceMemoryKey(fingerprint: string, shortKey: string): string {
  const clean = shortKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${WORKSPACE_MEMORY_PREFIX}${fingerprint}.${clean}`;
}

export function isWorkspaceMemoryFactKey(key: string): boolean {
  return key.startsWith(WORKSPACE_MEMORY_PREFIX) && key.split('.').length >= 3;
}

export async function listWorkspaceMemory(
  fingerprint: string,
): Promise<WorkspaceMemoryFact[]> {
  const prefix = `${WORKSPACE_MEMORY_PREFIX}${fingerprint}.`;
  const all = await getAllGlobalFacts();
  return all
    .filter((f) => f.key.startsWith(prefix))
    .slice(0, MAX_WORKSPACE_FACTS)
    .map((f) => ({
      key: f.key,
      shortKey: f.key.slice(prefix.length),
      value: f.value,
    }));
}

export async function upsertWorkspaceMemoryFact(
  fingerprint: string,
  shortKey: string,
  value: string,
  confidence = 0.85,
): Promise<void> {
  const trimmed = value.trim().slice(0, 500);
  if (!trimmed) return;
  await upsertGlobalFact(workspaceMemoryKey(fingerprint, shortKey), trimmed, confidence);
}

export async function clearWorkspaceMemory(fingerprint: string): Promise<number> {
  const prefix = `${WORKSPACE_MEMORY_PREFIX}${fingerprint}.`;
  const rows = await db.globalFact.findMany({
    where: { key: { startsWith: prefix } },
    select: { key: true },
  });
  for (const row of rows) {
    await deleteGlobalFact(row.key);
  }
  return rows.length;
}

/** Prompt block for active workspace (empty if none). */
export function formatWorkspaceMemoryForPrompt(facts: WorkspaceMemoryFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts
    .slice(0, MAX_WORKSPACE_FACTS)
    .map((f) => escapeForPrompt(`${f.shortKey}: ${f.value}`, { label: 'ws-mem' }));
  let block = `Что ты помнишь об этом workspace (из прошлых чатов, не выдумывай сверх этого):\n${lines.join('\n')}`;
  if (block.length > MAX_WORKSPACE_PROMPT_CHARS) {
    block = `${block.slice(0, MAX_WORKSPACE_PROMPT_CHARS - 1)}…`;
  }
  return block;
}

export async function getWorkspaceMemoryForPrompt(
  binding: WorkspaceBinding | null | undefined,
): Promise<string> {
  const fp = workspaceFingerprint(binding);
  if (!fp) return '';
  try {
    const facts = await listWorkspaceMemory(fp);
    return formatWorkspaceMemoryForPrompt(facts);
  } catch (e) {
    logger.warn('agent', 'getWorkspaceMemoryForPrompt failed', {}, e);
    return '';
  }
}

/**
 * Seed durable facts when a workspace is bound (idempotent upserts).
 * Also builds a cheap top-level overview if missing (no LLM).
 */
export async function bootstrapWorkspaceMemory(binding: WorkspaceBinding): Promise<void> {
  const fp = workspaceFingerprint(binding);
  if (!fp) return;

  try {
    await upsertWorkspaceMemoryFact(fp, 'label', binding.label, 1);
    await upsertWorkspaceMemoryFact(fp, 'kind', binding.kind, 1);
    if (binding.fsPath) {
      const short = binding.fsPath.length > 80
        ? `…${binding.fsPath.slice(-77)}`
        : binding.fsPath;
      await upsertWorkspaceMemoryFact(fp, 'path', short, 1);
    }

    if (binding.kind === 'kb' && binding.sourceIds.length > 0) {
      const sources = await db.source.findMany({
        where: { id: { in: binding.sourceIds } },
        select: { name: true, type: true },
      });
      if (sources.length > 0) {
        const names = sources.map((s) => `${s.name} (${s.type})`).join(', ').slice(0, 400);
        await upsertWorkspaceMemoryFact(fp, 'sources', names, 0.9);
      }
    }

    const existing = await listWorkspaceMemory(fp);
    if (!existing.some((f) => f.shortKey === 'overview') && binding.fsPath) {
      const overview = await buildDirOverview(binding.fsPath);
      if (overview) {
        await upsertWorkspaceMemoryFact(fp, 'overview', overview, 0.7);
      }
    }

    logger.info('agent', 'workspace memory bootstrapped', {
      fingerprint: fp,
      label: binding.label,
      facts: (await listWorkspaceMemory(fp)).length,
    });
  } catch (e) {
    logger.warn('agent', 'bootstrapWorkspaceMemory failed', { label: binding.label }, e);
  }
}

async function buildDirOverview(fsPath: string): Promise<string | null> {
  try {
    const entries = await readdir(fsPath, { withFileTypes: true });
    const names = entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 16)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (names.length === 0) return null;
    return `Корень: ${names.join(', ')}`;
  } catch {
    return null;
  }
}

/** Exclude workspace.* keys from the user-profile facts block. */
export function filterOutWorkspaceMemoryFacts<T extends { key: string }>(facts: T[]): T[] {
  return facts.filter((f) => !isWorkspaceMemoryFactKey(f.key));
}

/** @internal test helper */
export function parseFingerprintFromKey(key: string): string | null {
  if (!isWorkspaceMemoryFactKey(key)) return null;
  const rest = key.slice(WORKSPACE_MEMORY_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  return rest.slice(0, dot);
}
