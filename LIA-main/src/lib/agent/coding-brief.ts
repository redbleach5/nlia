import 'server-only';

/**
 * Persist / load coding task briefs via workspace memory.
 */

import {
  CODING_LAST_BRIEF_KEY,
  MAX_BRIEF_CHARS,
  fingerprintFromFsScope,
  formatCodingBriefForPrompt,
} from './coding-intent';
import {
  listWorkspaceMemory,
  upsertWorkspaceMemoryFact,
} from './workspace-memory';
import { logger } from '@/lib/logger';

export async function saveCodingTaskBrief(
  fsScope: string | null | undefined,
  brief: string,
): Promise<void> {
  const fp = fingerprintFromFsScope(fsScope);
  const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (!fp || !trimmed) return;
  try {
    await upsertWorkspaceMemoryFact(fp, CODING_LAST_BRIEF_KEY, trimmed, 0.9);
  } catch (e) {
    logger.warn('agent', 'saveCodingTaskBrief failed', { fp }, e);
  }
}

export async function loadCodingTaskBrief(
  fsScope: string | null | undefined,
): Promise<string> {
  const fp = fingerprintFromFsScope(fsScope);
  if (!fp) return '';
  try {
    const facts = await listWorkspaceMemory(fp);
    const hit = facts.find((f) => f.shortKey === CODING_LAST_BRIEF_KEY);
    return hit?.value?.trim().slice(0, MAX_BRIEF_CHARS) ?? '';
  } catch (e) {
    logger.warn('agent', 'loadCodingTaskBrief failed', { fp }, e);
    return '';
  }
}

export async function loadCodingBriefPromptBlock(
  fsScope: string | null | undefined,
): Promise<string> {
  const brief = await loadCodingTaskBrief(fsScope);
  return formatCodingBriefForPrompt(brief);
}
