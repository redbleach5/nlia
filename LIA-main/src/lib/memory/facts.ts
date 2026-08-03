import 'server-only';

// Facts — global profile + episode-scoped context.
//
// ГЛОБАЛЬНЫЕ факты (GlobalFact) — переживают смену чата:
//   user.name, user.profession, user.favorite_language и т.п.
//
// ЭПИЗОДНЫЕ факты (EpisodeFact) — стираются при закрытии чата:
//   "текущий проект — Lia v2", "пользователь просит проанализировать X"

import { db } from '@/lib/db';
import { encryptField, decryptField } from '@/lib/infra/field-crypto';
import { escapeForPrompt } from '@/lib/infra/prompt-safety';
import { WORKSPACE_FACT_KEY } from '@/lib/agent/workspace-types';

// ============================================================================
// Global facts — профиль пользователя
// ============================================================================
export async function getAllGlobalFacts(): Promise<Array<{ key: string; value: string; confidence: number }>> {
  const rows = await db.globalFact.findMany({
    orderBy: { key: 'asc' },
  });
  return rows.map(r => ({
    key: r.key,
    value: decryptField(r.value),  // Decrypt if encrypted
    confidence: r.confidence,
  }));
}

export async function getGlobalFact(key: string): Promise<string | null> {
  const row = await db.globalFact.findUnique({ where: { key } });
  return row ? decryptField(row.value) : null;
}

export async function deleteGlobalFact(key: string): Promise<void> {
  await db.globalFact.deleteMany({ where: { key } });
}

export const USER_NAME_FACT_KEY = 'user.name';

export function getUserNameFromFacts(facts: Array<{ key: string; value: string }>): string | null {
  const row = facts.find(f => f.key === USER_NAME_FACT_KEY)
    // Legacy double-prefix from older extraction (user.user.name)
    ?? facts.find(f => f.key === 'user.user.name');
  const name = row?.value?.trim();
  return name ? name : null;
}

export async function upsertGlobalFact(key: string, value: string, confidence = 0.7): Promise<void> {
  const encryptedValue = encryptField(value);  // Encrypt if enabled
  const existing = await db.globalFact.findUnique({ where: { key } });
  if (existing) {
    // Compare decrypted values to check if changed
    const existingDecrypted = decryptField(existing.value);
    if (existingDecrypted !== value) {
      await db.globalFact.update({
        where: { key },
        data: { value: encryptedValue, confidence, updatedAt: new Date() },
      });
    } else {
      await db.globalFact.update({
        where: { key },
        data: {
          confidence: Math.min(0.95, existing.confidence + 0.1),
          updatedAt: new Date(),
        },
      });
    }
  } else {
    try {
      await db.globalFact.create({ data: { key, value: encryptedValue, confidence } });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'P2002') throw e;
    }
  }
}

/**
 * Build a textual user profile from global facts (for system prompt).
 * Groups by prefix: user.* → "Собеседник", lia.* → "Я", прочее → "Прочее".
 */
export function formatGlobalFactsForPrompt(facts: Array<{ key: string; value: string }>): string {
  if (facts.length === 0) return '';

  // Workspace memory is injected separately via formatWorkspaceMemoryForPrompt.
  const filtered = facts.filter((f) => !f.key.startsWith('workspace.'));
  if (filtered.length === 0) return '';

  const grouped: Record<string, string[]> = {};
  for (const f of filtered) {
    const prefix = f.key.split('.')[0] ?? 'other';
    // H-MEM-1: key+value are user/LLM-derived — escape before system-prompt inject.
    (grouped[prefix] ??= []).push(escapeForPrompt(`${f.key}: ${f.value}`, { label: 'fact' }));
  }

  const lines: string[] = [];
  if (grouped.user) {
    lines.push('Собеседник:');
    for (const l of grouped.user) lines.push(`  ${l}`);
  }
  if (grouped.lia) {
    lines.push('Я (по прошлым чатам):');
    for (const l of grouped.lia) lines.push(`  ${l}`);
  }
  const otherKeys = Object.keys(grouped).filter(k => k !== 'user' && k !== 'lia');
  if (otherKeys.length > 0) {
    lines.push('Прочее:');
    for (const k of otherKeys) {
      for (const l of grouped[k]) lines.push(`  ${l}`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// Episode facts — контекст текущего чата
// ============================================================================
export async function getEpisodeFacts(episodeId: string): Promise<Array<{ key: string; value: string }>> {
  const rows = await db.episodeFact.findMany({
    where: { episodeId },
    orderBy: { ts: 'desc' },
    take: 30,
  });
  return rows.map(r => ({
    key: r.key,
    value: decryptField(r.value),  // Decrypt if encrypted
  }));
}

export async function upsertEpisodeFact(episodeId: string, key: string, value: string): Promise<void> {
  const encryptedValue = encryptField(value);  // Encrypt if enabled
  try {
    await db.episodeFact.upsert({
      where: { episodeId_key: { episodeId, key } },
      create: { episodeId, key, value: encryptedValue },
      update: { value: encryptedValue, ts: new Date() },
    });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
  }
}

export function formatEpisodeFactsForPrompt(facts: Array<{ key: string; value: string }>): string {
  if (facts.length === 0) return '';
  // Workspace binding is injected separately via formatWorkspaceForPrompt —
  // raw JSON must not land in the facts block.
  return facts
    .filter(f => f.key !== WORKSPACE_FACT_KEY && f.value.trim().length > 0)
    .map(f => escapeForPrompt(`${f.key}: ${f.value}`, { label: 'fact' }))
    .join('\n');
}
