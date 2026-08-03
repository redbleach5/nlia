/**
 * Run command tool — real implementation (replaces M5 stub).
 * Per docs/ARCHITECTURE.md § 8.2 (category E: Execution tools).
 *
 * Gated by LIA_ALLOW_SHELL=1. Runs shell commands in the workspace fsScope
 * with a timeout. Output is captured (stdout + stderr) and returned.
 *
 * Security:
 *   - Opt-in via LIA_ALLOW_SHELL
 *   - Commands run in the fsScope directory (chdir)
 *   - Strong denylist for shell metacharacters / dangerous patterns
 *   - Scrubbed environment (PATH/HOME/LANG/TERM only)
 *   - Timeout: 30 seconds (configurable)
 *   - Max output: 10KB stdout + 10KB stderr
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../util/logger.js";
import { env } from "../../util/env.js";

const execAsync = promisify(exec);

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10_000;

/** Patterns that indicate shell injection / high-risk commands. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /[;&`]/,
  /\$\(/,
  />\s*\/dev\//,
  /\|\s*(curl|wget|nc|ncat|bash|sh|zsh|python|perl|ruby)\b/i,
  /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
];

export function isShellAllowed(): boolean {
  return env.allowShell;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C",
    TERM: "dumb",
    TMPDIR: process.env.TMPDIR,
  };
}

export async function runCommand(
  command: string,
  opts: { cwd?: string | null; timeoutMs?: number },
): Promise<{
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}> {
  if (!isShellAllowed()) {
    return {
      command,
      stdout: "",
      stderr: "",
      exitCode: 1,
      durationMs: 0,
      error: "shell disabled (set LIA_ALLOW_SHELL=1 to enable run_command)",
    };
  }

  const cwd = opts.cwd ?? null;
  const timeout = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const startedAt = Date.now();

  if (DANGEROUS_PATTERNS.some((re) => re.test(command))) {
    throw new Error(`Command blocked (dangerous pattern detected): ${command.slice(0, 100)}`);
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd ?? undefined,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env: scrubbedEnv(),
    });

    const durationMs = Date.now() - startedAt;
    const truncatedStdout =
      stdout.length > MAX_OUTPUT_BYTES
        ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]"
        : stdout;
    const truncatedStderr =
      stderr.length > MAX_OUTPUT_BYTES
        ? stderr.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]"
        : stderr;

    logger.info(
      { command: command.slice(0, 60), cwd, durationMs, stdoutLength: stdout.length },
      "command executed",
    );

    return {
      command,
      stdout: truncatedStdout,
      stderr: truncatedStderr,
      exitCode: 0,
      durationMs,
    };
  } catch (e: unknown) {
    const durationMs = Date.now() - startedAt;
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };

    logger.warn(
      { command: command.slice(0, 60), err: err.message, exitCode: err.code },
      "command failed",
    );

    return {
      command,
      stdout: err.stdout?.slice(0, MAX_OUTPUT_BYTES) ?? "",
      stderr: err.stderr?.slice(0, MAX_OUTPUT_BYTES) ?? err.message ?? String(e),
      exitCode: err.code ?? 1,
      durationMs,
    };
  }
}
