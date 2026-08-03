/**
 * Project rules loader — AGENTS.md / .lia/rules.md / .cursorrules
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

const RULE_FILES = ["AGENTS.md", ".lia/rules.md", ".cursorrules", ".cursor/rules.md"] as const;
const DEFAULT_RULES_CAP_CHARS = 6_000;

function safeAbs(fsScope: string, rel: string): string | null {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(fsScope, rel);
  const r = relative(fsScope, abs);
  if (r.startsWith("..") || r === "") return null;
  if (!existsSync(abs)) return null;
  return abs;
}

export async function loadWorkspaceRules(
  fsScope: string,
  capChars = DEFAULT_RULES_CAP_CHARS,
): Promise<{ text: string; source: string | null }> {
  for (const rel of RULE_FILES) {
    try {
      const abs = safeAbs(fsScope, rel);
      if (!abs) continue;
      const raw = await readFile(abs, "utf-8");
      if (!raw.trim()) continue;
      const text =
        raw.length > capChars
          ? `${raw.slice(0, capChars)}\n…[rules truncated; see ${rel}]`
          : raw;
      return { text, source: rel };
    } catch {
      continue;
    }
  }
  return { text: "", source: null };
}
