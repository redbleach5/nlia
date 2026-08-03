import 'server-only';

// ============================================================================
// run_command — scoped project shell for the agent (tests / git / package scripts).
// ============================================================================
//
// Design (lean, local-first):
//   - execFile only (NO shell) → no `|`, `;`, `$()`, redirection injection
//   - cwd must resolve inside task.fsScope
//   - binary allowlist (basename only — no /usr/bin/… paths)
//   - git: subcommand allowlist + block --force push / --hard / clean / global config
//   - timeout + truncated stdout/stderr
//   - scrub secrets from env (LIA_*, tokens); keep PATH/HOME/DATABASE_URL for tests
//
// Not a general terminal. For snippets use code_run (sandbox). For repo work use this.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentTask } from '../task';
import { resolveScopedPath } from '../fs-helpers';
import {
  sanitizeCommandArgs,
  sanitizePackageManagerArgs,
  isDangerousPackageCommand,
} from '../command-sanitize';
import { emitAgentEvent } from '../events';
import { getTaskApplyMode } from '../file-changes';
import { resolvePermissionTier, shellNeedsPermission } from '../permission-tiers';
import { waitForUserInput } from '../wait-input';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 80_000;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 2_000;

/** Binaries the agent may invoke (basename only). */
export const RUN_COMMAND_ALLOWED = new Set([
  'git',
  'bun',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'tsc',
  'vitest',
  'cargo',
  'go',
  'make',
  'pytest',
  'pip',
  'pip3',
]);

/** Safe git verbs for coding workflow. */
export const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'branch',
  'checkout',
  'switch',
  'stash',
  'rev-parse',
  'ls-files',
  'blame',
  'restore',
  'reset',
  'merge',
  'rebase',
  'tag',
  'fetch',
  'pull',
  'push',
  'remote',
  'describe',
  'shortlog',
]);

const SECRET_ENV_RE = /(SECRET|TOKEN|API_KEY|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;
const SCRUB_PREFIXES = ['LIA_', 'AWS_', 'OPENAI_', 'ANTHROPIC_', 'GROQ_', 'GITHUB_', 'GH_', 'STRIPE_', 'NPM_TOKEN'];

export type RunCommandValidation =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: string };

/** Pure validation — exported for unit tests. */
export function validateRunCommand(command: string, args: string[]): RunCommandValidation {
  const bin = command.trim();
  if (!bin) return { ok: false, error: 'command is empty' };
  if (bin.includes('/') || bin.includes('\\') || bin.includes('\0')) {
    return { ok: false, error: 'command must be a bare binary name (no path)' };
  }
  if (!RUN_COMMAND_ALLOWED.has(bin)) {
    return {
      ok: false,
      error: `command "${bin}" not allowed. Allowed: ${[...RUN_COMMAND_ALLOWED].sort().join(', ')}`,
    };
  }
  if (args.length > MAX_ARGS) {
    return { ok: false, error: `too many args (max ${MAX_ARGS})` };
  }
  for (const a of args) {
    if (typeof a !== 'string') return { ok: false, error: 'args must be strings' };
    if (a.includes('\0')) return { ok: false, error: 'null byte in args' };
    if (a.length > MAX_ARG_LEN) return { ok: false, error: `arg too long (max ${MAX_ARG_LEN})` };
  }

  const meta = sanitizeCommandArgs(args);
  if (!meta.ok) return { ok: false, error: meta.error };

  const pkg = sanitizePackageManagerArgs(bin, args);
  if (!pkg.ok) return { ok: false, error: pkg.error };

  if (bin === 'git') {
    const sub = args.find(a => a.length > 0 && !a.startsWith('-'));
    if (!sub) return { ok: false, error: 'git requires a subcommand' };
    if (!GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        error: `git "${sub}" not allowed. Allowed: ${[...GIT_ALLOWED_SUBCOMMANDS].sort().join(', ')}`,
      };
    }
    if (sub === 'clean') {
      return { ok: false, error: 'git clean is blocked' };
    }
    if (sub === 'push' && args.some(a => a === '--force' || a === '-f' || a.startsWith('--force='))) {
      return { ok: false, error: 'git push --force is blocked' };
    }
    if (args.includes('--hard')) {
      return { ok: false, error: 'git --hard is blocked' };
    }
    if (args.some(a => a === '--global' || a === '--system')) {
      return { ok: false, error: 'git --global/--system is blocked' };
    }
  }

  return { ok: true, command: bin, args };
}

/** Strip secrets from env while keeping enough for bun/npm/git tests. */
export function scrubCommandEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (SCRUB_PREFIXES.some(p => k.startsWith(p))) continue;
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + '\n…[truncated]', truncated: true };
}

export function makeRunCommandTool(task: AgentTask) {
  return tool({
    description:
      'Выполнить команду в рабочей директории задачи (fsScope). '
      + 'Без shell: только allowlist бинарников (git, bun, npm, node, python, vitest, …) и argv-массив. '
      + 'Для тестов проекта: run_command({ command: "bun", args: ["run", "test:ci"] }) или npm/pytest. '
      + 'Для git: status/diff/log/add/commit/… (force push и --hard запрещены). '
      + 'Для произвольного сниппета в sandbox — code_run, не этот tool.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Бинарник из allowlist, напр. bun, git, npm, vitest'),
      args: z.array(z.string()).default([]).describe('Аргументы без shell-метасимволов'),
      cwd: z.string().default('.').describe('Относительный путь cwd внутри fsScope (по умолчанию ".")'),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional()
        .describe(`Таймаут мс (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
    }),
    execute: async ({ command, args, cwd, timeoutMs }) => {
      const validated = validateRunCommand(command, args ?? []);
      if (!validated.ok) return { error: validated.error, success: false };

      const applyMode = getTaskApplyMode(task.id);
      const tier = resolvePermissionTier('edit', applyMode);
      // install/ci always ask (even edit-auto); other shell only in edit-ask.
      const needsAsk =
        isDangerousPackageCommand(validated.command, validated.args)
        || shellNeedsPermission(tier);
      if (needsAsk) {
        emitAgentEvent({
          type: 'permission_request',
          taskId: task.id,
          requestId: crypto.randomUUID(),
          kind: 'shell',
          detail: `Разрешить ${validated.command} ${(validated.args ?? []).join(' ')}?`.slice(0, 240),
          payload: { command: validated.command, args: validated.args },
          ts: Date.now(),
        });
        const answer = await waitForUserInput(
          task.id,
          `Разрешить команду: ${validated.command} ${(validated.args ?? []).slice(0, 6).join(' ')}? (да/нет)`,
        );
        if (!/^(да|yes|y|ok|ага|разреш)/i.test(answer.trim())) {
          return { error: 'command denied by user', success: false, denied: true };
        }
      }

      const scoped = await resolveScopedPath(task, cwd || '.', 'Команды без рабочей директории запрещены.');
      if (!scoped.ok) return { error: scoped.error, success: false };

      const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const started = Date.now();

      try {
        // Windows: npm/npx/yarn/pnpm/bun are .cmd shims — execFile without
        // extension → ENOENT. Prefer *.cmd over shell:true to keep no-shell safety.
        const command =
          process.platform === 'win32'
          && /^(npx|npm|yarn|pnpm|bun)$/i.test(validated.command)
            ? `${validated.command}.cmd`
            : validated.command;

        const { stdout, stderr } = await execFileAsync(command, validated.args, {
          cwd: scoped.fullPath,
          timeout,
          maxBuffer: MAX_OUTPUT_CHARS * 2,
          env: scrubCommandEnv() as NodeJS.ProcessEnv,
          encoding: 'utf8',
          windowsHide: true,
        });

        const out = truncate(stdout ?? '', MAX_OUTPUT_CHARS);
        const err = truncate(stderr ?? '', MAX_OUTPUT_CHARS);
        if (out.text) {
          emitAgentEvent({
            type: 'runtime_log',
            taskId: task.id,
            stream: 'stdout',
            text: out.text.slice(0, 4_000),
            ts: Date.now(),
          });
        }
        if (err.text) {
          emitAgentEvent({
            type: 'runtime_log',
            taskId: task.id,
            stream: 'stderr',
            text: err.text.slice(0, 4_000),
            ts: Date.now(),
          });
        }
        return {
          command: validated.command,
          args: validated.args,
          cwd: cwd || '.',
          exitCode: 0,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          durationMs: Date.now() - started,
          success: true,
        };
      } catch (e) {
        const err = e as {
          code?: string;
          killed?: boolean;
          signal?: string;
          status?: number;
          stdout?: string;
          stderr?: string;
          message?: string;
        };

        if (err.code === 'ENOENT') {
          return {
            error: `binary not found: ${validated.command}`,
            success: false,
            durationMs: Date.now() - started,
          };
        }

        const out = truncate(String(err.stdout ?? ''), MAX_OUTPUT_CHARS);
        const errOut = truncate(String(err.stderr ?? err.message ?? ''), MAX_OUTPUT_CHARS);
        const timedOut = err.killed === true || err.signal === 'SIGTERM';

        logger.info('agent', 'run_command finished non-zero', {
          command: validated.command,
          exitCode: err.status ?? null,
          timedOut,
          durationMs: Date.now() - started,
        });

        return {
          command: validated.command,
          args: validated.args,
          cwd: cwd || '.',
          exitCode: typeof err.status === 'number' ? err.status : timedOut ? 124 : 1,
          stdout: out.text,
          stderr: errOut.text,
          truncated: out.truncated || errOut.truncated,
          timedOut,
          durationMs: Date.now() - started,
          success: false,
        };
      }
    },
  });
}
