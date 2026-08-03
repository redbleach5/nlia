import 'server-only';

/**
 * Build rules + @mention context block for agent system prompt (P2).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMentions, type AgentMention } from './mentions';
import { loadWorkspaceRules } from './rules-loader';
import { compressFileForContext, estimateCharsBudget } from './context-compress';
import { safePathWithinScope } from './fs-scope';
import { logger } from '@/lib/logger';

const TOTAL_CAP = 14_000;
const FOLDER_TOP_N = 8;

export async function buildMentionAndRulesContext(params: {
  goal: string;
  fsScope: string | null;
}): Promise<{ block: string; rulesSource: string | null; mentionCount: number }> {
  if (!params.fsScope) {
    return { block: '', rulesSource: null, mentionCount: 0 };
  }

  const parts: string[] = [];
  const rules = await loadWorkspaceRules(params.fsScope);
  if (rules.text) {
    parts.push(`## Project rules (${rules.source})\n${rules.text}`);
  }

  const mentions = parseMentions(params.goal);
  for (const m of mentions) {
    try {
      const chunk = await loadMention(params.fsScope, m, params.goal);
      if (chunk) parts.push(chunk);
    } catch (e) {
      logger.debug('agent', 'mention load failed', {
        path: m.path,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const block = estimateCharsBudget(parts, TOTAL_CAP);
  return {
    block: block
      ? `\n\n# Workspace context (rules + @mentions)\n${block}`
      : '',
    rulesSource: rules.source,
    mentionCount: mentions.length,
  };
}

async function loadMention(
  fsScope: string,
  m: AgentMention,
  goal: string,
): Promise<string | null> {
  if (m.kind === 'file') {
    const abs = await safePathWithinScope(m.path, fsScope);
    if (!abs) return `MENTION @file:${m.path} — outside scope`;
    const content = await readFile(abs, 'utf8');
    const compressed = compressFileForContext(m.path, content, {
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
    });
    return compressed.text;
  }

  // folder
  const abs = await safePathWithinScope(m.path, fsScope);
  if (!abs) return `MENTION @folder:${m.path} — outside scope`;
  const entries = await readdir(abs, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const stem = goal.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ');
  const scored = files
    .map((name) => {
      let score = 0;
      const n = name.toLowerCase();
      for (const tok of stem.split(/\s+/).filter((t) => t.length > 2)) {
        if (n.includes(tok)) score += 5;
      }
      return { name, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, FOLDER_TOP_N);
  const lines = [`FOLDER ${m.path}/ (${files.length} files, top-${top.length}):`];
  for (const f of top) {
    try {
      const full = join(abs, f.name);
      const st = await stat(full);
      lines.push(`- ${f.name} (${st.size}b)`);
    } catch {
      lines.push(`- ${f.name}`);
    }
  }
  lines.push('…[folder truncated; use list_tree / read_file / grep]');
  return lines.join('\n');
}
