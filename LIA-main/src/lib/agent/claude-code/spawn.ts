import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import { resolveClaudeBinary } from './detect';
import { buildClaudeCodeChildEnv, type ClaudeCodeEnvInput } from './env';
import {
  createAfterResultWatchdog,
  streamChunkContainsResultEvent,
  CC_AFTER_RESULT_GRACE_MS,
} from './after-result-watchdog';
import { logger } from '@/lib/logger';

export type SpawnClaudeCodeOpts = {
  cwd: string;
  prompt: string;
  model: string;
  envInput: ClaudeCodeEnvInput;
  signal?: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** Grace after stream `result` before SIGTERM (default CC_AFTER_RESULT_GRACE_MS). */
  afterResultGraceMs?: number;
  /** Resume prior Claude Code session when CLI supports --resume. */
  resumeSessionId?: string;
};

export type SpawnClaudeCodeResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  /** True if we SIGTERM'd because CLI stayed up after result. */
  terminatedAfterResult?: boolean;
};

const activeChildren = new Map<string, ChildProcess>();

export function getClaudeCodePid(taskId: string): number | null {
  return activeChildren.get(taskId)?.pid ?? null;
}

export function killClaudeCodeProcess(taskId: string): void {
  const child = activeChildren.get(taskId);
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch { /* ignore */ }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch { /* ignore */ }
  }, 2_000);
}

export async function spawnClaudeCode(
  taskId: string,
  opts: SpawnClaudeCodeOpts,
): Promise<SpawnClaudeCodeResult> {
  const binary = await resolveClaudeBinary();
  if (!binary) {
    throw new Error(
      'Claude Code CLI не найден в PATH. Установи CLI и перезапусти терминал/сервер.',
    );
  }

  const { env, anthropicBaseUrl } = buildClaudeCodeChildEnv(opts.envInput);
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (opts.model.trim()) {
    args.push('--model', opts.model.trim());
  }
  if (opts.resumeSessionId?.trim()) {
    args.push('--resume', opts.resumeSessionId.trim());
  }

  logger.info('agent', 'Claude Code spawn', {
    taskId: taskId.slice(0, 8),
    cwd: opts.cwd,
    model: opts.model,
    baseUrl: anthropicBaseUrl,
    argsPreview: args.filter((a) => a !== opts.prompt).join(' '),
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminatedAfterResult = false;
    let lineBuf = '';

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.set(taskId, child);

    const watchdog = createAfterResultWatchdog({
      graceMs: opts.afterResultGraceMs ?? CC_AFTER_RESULT_GRACE_MS,
      kill: () => {
        if (settled) return;
        terminatedAfterResult = true;
        logger.info('agent', 'CC after-result grace elapsed — terminating CLI', {
          taskId: taskId.slice(0, 8),
          pid: child.pid,
        });
        killClaudeCodeProcess(taskId);
      },
    });

    const onAbort = () => {
      watchdog.clear();
      killClaudeCodeProcess(taskId);
    };
    opts.signal?.addEventListener('abort', onAbort);

    const settleClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      activeChildren.delete(taskId);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal,
        pid: child.pid ?? null,
        terminatedAfterResult,
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      opts.onStdout(chunk);
      // Detect result across chunk boundaries.
      lineBuf += chunk;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      const complete = parts.join('\n') + (parts.length ? '\n' : '');
      if (complete && streamChunkContainsResultEvent(complete)) {
        watchdog.onResult();
      }
      // Also check leftover if a full JSON line sits in buffer without newline yet — rare.
      if (lineBuf && streamChunkContainsResultEvent(lineBuf)) {
        watchdog.onResult();
      }
    });
    child.stderr?.on('data', (chunk: string) => opts.onStderr(chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      activeChildren.delete(taskId);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code, signal) => {
      settleClose(code, signal);
    });
  });
}
