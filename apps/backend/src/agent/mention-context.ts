/**
 * Build rules + @mention context block for agent system prompt.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { parseMentions, type AgentMention } from "./mentions.js";
import { loadWorkspaceRules } from "./rules-loader.js";
import { logger } from "../util/logger.js";

const TOTAL_CAP = 14_000;
const FILE_CAP = 8_000;
const FOLDER_TOP_N = 8;

function safeAbs(fsScope: string, inputPath: string): string | null {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(fsScope, inputPath);
  const rel = relative(fsScope, abs);
  if (rel.startsWith("..")) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

function compressFile(
  path: string,
  content: string,
  opts?: { lineStart?: number; lineEnd?: number },
): string {
  let body = content;
  if (opts?.lineStart != null) {
    const lines = content.split("\n");
    const start = Math.max(0, opts.lineStart - 1);
    const end = opts.lineEnd != null ? opts.lineEnd : Math.min(lines.length, start + 80);
    body = lines.slice(start, end).join("\n");
    return `FILE ${path}#L${opts.lineStart}${opts.lineEnd ? `-${opts.lineEnd}` : ""}\n\`\`\`\n${body.slice(0, FILE_CAP)}\n\`\`\``;
  }
  if (body.length > FILE_CAP) {
    body = `${body.slice(0, FILE_CAP)}\n…[truncated ${body.length - FILE_CAP} chars]`;
  }
  return `FILE ${path}\n\`\`\`\n${body}\n\`\`\``;
}

function budgetJoin(parts: string[], cap: number): string {
  let used = 0;
  const out: string[] = [];
  for (const p of parts) {
    if (used >= cap) break;
    const slice = p.length + used > cap ? p.slice(0, Math.max(0, cap - used)) : p;
    if (!slice) break;
    out.push(slice);
    used += slice.length + 2;
  }
  return out.join("\n\n");
}

export async function buildMentionAndRulesContext(params: {
  goal: string;
  fsScope: string | null;
}): Promise<{ block: string; rulesSource: string | null; mentionCount: number }> {
  if (!params.fsScope) {
    return { block: "", rulesSource: null, mentionCount: 0 };
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
      logger.debug(
        { path: m.path, err: e instanceof Error ? e.message : String(e) },
        "mention load failed",
      );
    }
  }

  const inner = budgetJoin(parts, TOTAL_CAP);
  return {
    block: inner ? `\n\n# Workspace context (rules + @mentions)\n${inner}` : "",
    rulesSource: rules.source,
    mentionCount: mentions.length,
  };
}

async function loadMention(
  fsScope: string,
  m: AgentMention,
  goal: string,
): Promise<string | null> {
  if (m.kind === "file") {
    const abs = safeAbs(fsScope, m.path);
    if (!abs) return `MENTION @file:${m.path} — outside scope or missing`;
    const content = await readFile(abs, "utf-8");
    return compressFile(m.path, content, {
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
    });
  }

  const abs = safeAbs(fsScope, m.path);
  if (!abs) return `MENTION @folder:${m.path} — outside scope or missing`;
  const entries = await readdir(abs, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);

  const stem = goal.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, " ");
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
  lines.push("…[folder truncated; use list_tree / read_file / grep]");
  return lines.join("\n");
}
