import 'server-only';

/**
 * Project rules loader — AGENTS.md / .lia/rules.md / .cursorrules
 */

import { readFile } from 'node:fs/promises';
import { safePathWithinScope } from './fs-scope';

const RULE_FILES = ['AGENTS.md', '.lia/rules.md', '.cursorrules', '.cursor/rules.md'] as const;
const DEFAULT_RULES_CAP_CHARS = 6_000;

export async function loadWorkspaceRules(
  fsScope: string,
  capChars = DEFAULT_RULES_CAP_CHARS,
): Promise<{ text: string; source: string | null }> {
  for (const rel of RULE_FILES) {
    try {
      const abs = await safePathWithinScope(rel, fsScope);
      if (!abs) continue;
      const raw = await readFile(abs, 'utf8');
      if (!raw.trim()) continue;
      const text = raw.length > capChars
        ? `${raw.slice(0, capChars)}\n…[rules truncated; see ${rel}]`
        : raw;
      return { text, source: rel };
    } catch {
      continue;
    }
  }
  return { text: '', source: null };
}
