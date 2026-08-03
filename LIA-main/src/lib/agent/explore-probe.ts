import 'server-only';

/**
 * Bounded deterministic explore before PLAN (edit/coding goals).
 * No LLM tools loop — list_tree depth 2 + light grep on goal tokens.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { shouldSkipFsEntry } from './fs-helpers';

const SKETCH_CAP = 2_000;
const MAX_GREP_HITS = 12;
const MAX_GREP_FILES = 40;

function tokenizeGoal(goal: string): string[] {
  return goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./-]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && t.length <= 40)
    .slice(0, 8);
}

async function listTreeSketch(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): Promise<void> {
  if (depth > maxDepth || lines.join('\n').length > SKETCH_CAP) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.slice(0, 40)) {
    if (shouldSkipFsEntry(e.name)) continue;
    if (e.isSymbolicLink?.()) continue;
    const full = join(dir, e.name);
    const rel = relative(root, full).replace(/\\/g, '/') || e.name;
    if (e.isDirectory()) {
      lines.push(`${'  '.repeat(depth)}${rel}/`);
      await listTreeSketch(root, full, depth + 1, maxDepth, lines);
    } else if (e.isFile()) {
      lines.push(`${'  '.repeat(depth)}${rel}`);
    }
    if (lines.join('\n').length > SKETCH_CAP) return;
  }
}

async function lightGrep(
  root: string,
  tokens: string[],
): Promise<string[]> {
  if (tokens.length === 0) return [];
  const hits: string[] = [];
  const stack = [root];
  let filesChecked = 0;

  while (stack.length > 0 && hits.length < MAX_GREP_HITS && filesChecked < MAX_GREP_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (shouldSkipFsEntry(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.next', 'coverage'].includes(e.name)) {
          stack.push(full);
        }
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(tsx?|jsx?|md|json|css)$/i.test(e.name)) continue;
      filesChecked += 1;
      try {
        const st = await stat(full);
        if (st.size > 80_000) continue;
        const text = await readFile(full, 'utf8');
        const lower = text.toLowerCase();
        const matched = tokens.filter((t) => lower.includes(t));
        if (matched.length > 0) {
          const rel = relative(root, full).replace(/\\/g, '/');
          hits.push(`${rel} ← ${matched.slice(0, 3).join(', ')}`);
        }
      } catch { /* skip */ }
      if (hits.length >= MAX_GREP_HITS || filesChecked >= MAX_GREP_FILES) break;
    }
  }
  return hits;
}

/**
 * Build a short codebase sketch for the planner (≤2k chars).
 */
export async function buildCodebaseSketch(
  fsScope: string | null | undefined,
  goal: string,
): Promise<string> {
  if (!fsScope) return '';
  try {
    const lines: string[] = [];
    await listTreeSketch(fsScope, fsScope, 0, 2, lines);
    const tokens = tokenizeGoal(goal);
    const hits = await lightGrep(fsScope, tokens);
    const parts = [
      'Codebase sketch (auto, depth≤2):',
      lines.slice(0, 60).join('\n') || '(пусто)',
    ];
    if (hits.length > 0) {
      parts.push('Keyword hits:', ...hits);
    }
    let out = parts.join('\n');
    if (out.length > SKETCH_CAP) out = `${out.slice(0, SKETCH_CAP - 1)}…`;
    return out;
  } catch {
    return '';
  }
}
