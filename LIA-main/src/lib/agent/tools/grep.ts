import 'server-only';

import { tool } from 'ai';
import { z } from 'zod';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { AgentTask } from '../task';
import { resolveScopedPath, walkScope, isTextFile } from '../fs-helpers';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);
// Same pattern as edit_file (tools.ts) — native re2 via createRequire, never eval.
const dynamicRequire = createRequire(import.meta.url);

/** Cap LLM-supplied patterns (ReDoS + rg arg size). */
export const MAX_GREP_PATTERN_LEN = 200;

export type GrepHit = {
  path: string;
  line: number;
  text: string;
};

let cachedRgPath: string | null | undefined;

/** Resolve ripgrep binary once (PATH). null = use Node fallback. */
async function resolveRgBinary(): Promise<string | null> {
  if (cachedRgPath !== undefined) return cachedRgPath;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['rg'], {
      timeout: 3000,
      windowsHide: true,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    cachedRgPath = first || null;
  } catch {
    cachedRgPath = null;
  }
  return cachedRgPath;
}

type CompiledGrepPattern =
  | { ok: true; match: (line: string) => boolean; engine: 're2' | 'literal' }
  | { ok: false; error: string };

/**
 * Compile a grep pattern for the Node fallback.
 *
 * Prefer RE2 (linear-time, same as edit_file). Never use V8 `RegExp` here —
 * catastrophic backtracking like `(a+)+` would hang the event loop across
 * every line of every file. If re2 is missing or the pattern uses unsupported
 * features, fall back to literal substring match (safe, not regex).
 */
export function compileGrepPattern(
  pattern: string,
  caseInsensitive: boolean,
): CompiledGrepPattern {
  if (pattern.length > MAX_GREP_PATTERN_LEN) {
    return {
      ok: false,
      error: `Pattern too long (${pattern.length} > ${MAX_GREP_PATTERN_LEN} chars)`,
    };
  }

  const flags = caseInsensitive ? 'i' : '';
  try {
    const RE2 = dynamicRequire('re2');
    const re = new RE2(pattern, flags);
    return { ok: true, engine: 're2', match: (line) => re.test(line) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('tools', 'grep Node fallback: re2 unavailable or invalid pattern — literal match only', {
      message: msg.slice(0, 160),
      patternLen: pattern.length,
    });
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    return {
      ok: true,
      engine: 'literal',
      match: (line) => (caseInsensitive ? line.toLowerCase() : line).includes(needle),
    };
  }
}

async function grepWithNode(opts: {
  root: string;
  pattern: string;
  pathPrefix: string;
  maxResults: number;
  caseInsensitive: boolean;
  globExt: string;
}): Promise<{ hits: GrepHit[] } | { error: string }> {
  const compiled = compileGrepPattern(opts.pattern, opts.caseInsensitive);
  if (!compiled.ok) return { error: compiled.error };

  const results: GrepHit[] = [];
  const prefix = opts.pathPrefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');

  await walkScope(opts.root, async (entry) => {
    if (results.length >= opts.maxResults) return 'stop';
    if (!entry.isFile || !isTextFile(entry.name)) return;

    const rel = entry.relativePath.replace(/\\/g, '/');
    if (prefix && !rel.startsWith(prefix) && rel !== prefix) {
      // allow prefix as directory: "src/lib" matches files under it
      if (!(`${rel}/`.startsWith(`${prefix}/`) || rel.startsWith(`${prefix}/`))) return;
    }

    if (opts.globExt) {
      const ext = entry.name.split('.').pop()?.toLowerCase();
      if (ext !== opts.globExt.toLowerCase()) return;
    }

    try {
      const content = await readFile(entry.fullPath, 'utf8');
      if (content.length > 200_000) return;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= opts.maxResults) return 'stop';
        if (compiled.match(lines[i])) {
          results.push({
            path: rel,
            line: i + 1,
            text: lines[i].slice(0, 240),
          });
        }
      }
    } catch {
      /* skip */
    }
  });

  return { hits: results };
}

async function grepWithRg(opts: {
  rgPath: string;
  root: string;
  pattern: string;
  pathPrefix: string;
  maxResults: number;
  caseInsensitive: boolean;
  globExt: string;
}): Promise<GrepHit[] | null> {
  const args = [
    '--json',
    '--line-number',
    '--no-heading',
    '--color', 'never',
    '-m', String(opts.maxResults),
    '--glob', '!.git/**',
    '--glob', '!node_modules/**',
    '--glob', '!.next/**',
    '--glob', '!dist/**',
    '--glob', '!*.db',
    '--glob', '!*.lock',
  ];
  if (opts.caseInsensitive) args.push('-i');
  if (opts.globExt) args.push('--glob', `*.${opts.globExt.replace(/^\./, '')}`);

  args.push('--', opts.pattern);
  const searchRoot = opts.pathPrefix
    ? join(opts.root, opts.pathPrefix)
    : opts.root;
  args.push(searchRoot);

  try {
    const { stdout } = await execFileAsync(opts.rgPath, args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      cwd: opts.root,
    });
    const hits: GrepHit[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim() || hits.length >= opts.maxResults) break;
      try {
        const row = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (row.type !== 'match' || !row.data) continue;
        const abs = row.data.path?.text ?? '';
        const rel = abs.startsWith(opts.root)
          ? abs.slice(opts.root.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
          : abs.replace(/\\/g, '/');
        hits.push({
          path: rel,
          line: row.data.line_number ?? 0,
          text: (row.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240),
        });
      } catch {
        /* skip bad json line */
      }
    }
    return hits;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    // rg exits 1 when no matches — still parse stdout
    if (err.code === 1 && typeof err.stdout === 'string') {
      const hits: GrepHit[] = [];
      for (const line of err.stdout.split(/\r?\n/)) {
        if (!line.trim() || hits.length >= opts.maxResults) break;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
            };
          };
          if (row.type !== 'match' || !row.data) continue;
          const abs = row.data.path?.text ?? '';
          const rel = abs.startsWith(opts.root)
            ? abs.slice(opts.root.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
            : abs.replace(/\\/g, '/');
          hits.push({
            path: rel,
            line: row.data.line_number ?? 0,
            text: (row.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240),
          });
        } catch { /* skip */ }
      }
      return hits;
    }
    logger.debug('tools', 'rg failed — falling back to Node grep', {
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Shared workspace grep used by `grep` and the `file_search` alias.
 */
export async function executeGrepSearch(
  task: AgentTask,
  params: {
    pattern: string;
    path?: string;
    maxResults?: number;
    caseInsensitive?: boolean;
    extension?: string;
  },
): Promise<
  | {
      pattern: string;
      path: string;
      engine: 'rg' | 'node';
      count: number;
      truncated: boolean;
      hits: GrepHit[];
      hint: string;
    }
  | { error: string }
> {
  const pattern = params.pattern;
  const maxResults = params.maxResults ?? 20;
  const caseInsensitive = params.caseInsensitive ?? false;
  const extension = params.extension ?? '';
  const path = params.path ?? '';

  if (pattern.length > MAX_GREP_PATTERN_LEN) {
    return { error: `Pattern too long (max ${MAX_GREP_PATTERN_LEN} chars)` };
  }

  const scoped = await resolveScopedPath(task, path?.trim() || '.', 'Grep запрещён без рабочей директории.');
  if (!scoped.ok) return { error: scoped.error };

  const rootScoped = await resolveScopedPath(task, '.', 'Grep запрещён.');
  if (!rootScoped.ok) return { error: rootScoped.error };

  const pathPrefix = (path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const rg = await resolveRgBinary();

  let engine: 'rg' | 'node' = 'node';
  let hits: GrepHit[] = [];

  if (rg) {
    const rgHits = await grepWithRg({
      rgPath: rg,
      root: rootScoped.fullPath,
      pattern,
      pathPrefix,
      maxResults,
      caseInsensitive,
      globExt: extension,
    });
    if (rgHits !== null) {
      hits = rgHits;
      engine = 'rg';
    }
  }

  if (engine === 'node') {
    const nodeResult = await grepWithNode({
      root: rootScoped.fullPath,
      pattern,
      pathPrefix,
      maxResults,
      caseInsensitive,
      globExt: extension,
    });
    if ('error' in nodeResult) return { error: nodeResult.error };
    hits = nodeResult.hits;
  }

  return {
    pattern,
    path: pathPrefix || '.',
    engine,
    count: hits.length,
    truncated: hits.length >= maxResults,
    hits,
    hint: hits.length === 0
      ? 'Ничего не найдено. Попробуй короче pattern или path=src, затем read_file по hit.path.'
      : 'Дальше: read_file(path=hit.path) для полного контекста.',
  };
}

/**
 * Grep over the agent workspace (fsScope).
 * Prefers ripgrep when available; otherwise Node walk + RE2 (never V8 RegExp).
 */
export function makeGrepTool(task: AgentTask) {
  return tool({
    description:
      'Точный поиск по коду (как ripgrep). Ищи символы/строки из цели задачи. '
      + 'path — подпапка относительно workspace (напр. src или app; пусто = весь workspace). '
      + 'pattern — подстрока или regex без слэшей (RE2; без backreferences/lookahead).',
    inputSchema: z.object({
      pattern: z.string().min(1).max(MAX_GREP_PATTERN_LEN)
        .describe('Подстрока или regex (например authenticateUser или Math.random)'),
      path: z.string().default('').describe('Ограничить поиск папкой, напр. src (пусто = весь workspace)'),
      maxResults: z.number().int().min(1).max(50).default(20),
      caseInsensitive: z.boolean().default(false),
      extension: z.string().default('').describe('Фильтр расширения без точки: ts, tsx, py (пусто = текстовые файлы)'),
    }),
    execute: async ({ pattern, path, maxResults, caseInsensitive, extension }) =>
      executeGrepSearch(task, { pattern, path, maxResults, caseInsensitive, extension }),
  });
}

/** Test helper — reset cached rg path between tests. */
export function _resetRgCacheForTests(): void {
  cachedRgPath = undefined;
}

/** Test helper — force Node engine. */
export function _setRgCacheForTests(value: string | null): void {
  cachedRgPath = value;
}
