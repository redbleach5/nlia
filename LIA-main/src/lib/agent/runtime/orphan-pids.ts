import 'server-only';

/**
 * Persist Create Runtime PIDs so a full Next.js restart can kill orphans.
 * In-memory ChildProcess refs die with the Node process; these JSON files survive.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '@/lib/paths';
import { logger } from '@/lib/logger';

export type RuntimePidRecord = {
  taskId: string;
  pid: number;
  port: number | null;
  startedAt: number;
};

function pidDir(): string {
  return PATHS.runtimePids;
}

function pidFilePath(taskId: string, dir = pidDir()): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return join(dir, `${safe}.json`);
}

export async function persistRuntimePid(
  rec: RuntimePidRecord,
  dir = pidDir(),
): Promise<void> {
  if (!Number.isFinite(rec.pid) || rec.pid <= 0) return;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(pidFilePath(rec.taskId, dir), JSON.stringify(rec), 'utf8');
  } catch (e) {
    logger.warn('agent', 'persistRuntimePid failed', { taskId: rec.taskId.slice(0, 8) }, e);
  }
}

export async function clearRuntimePid(taskId: string, dir = pidDir()): Promise<void> {
  try {
    await unlink(pidFilePath(taskId, dir));
  } catch {
    /* missing is fine */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill process tree by PID (no ChildProcess handle — post-restart orphans). */
export async function killProcessTreeByPid(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (!isProcessAlive(pid)) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const done = () => resolve();
      killer.on('exit', done);
      killer.on('error', done);
      setTimeout(done, 4000);
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
}

/**
 * On server start: kill any persisted runtime PIDs still alive, then remove files.
 * Returns number of PID files processed (alive or dead).
 */
export async function sweepOrphanRuntimes(dir = pidDir()): Promise<number> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }

  let n = 0;
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      const raw = await readFile(full, 'utf8');
      const rec = JSON.parse(raw) as RuntimePidRecord;
      if (typeof rec.pid === 'number' && rec.pid > 0) {
        if (isProcessAlive(rec.pid)) {
          logger.info('agent', 'sweeping orphan runtime process', {
            taskId: String(rec.taskId ?? '').slice(0, 8),
            pid: rec.pid,
            port: rec.port,
          });
          await killProcessTreeByPid(rec.pid);
        }
      }
      await unlink(full).catch(() => null);
      n += 1;
    } catch (e) {
      logger.warn('agent', 'sweepOrphanRuntimes: bad pid file', { file: name }, e);
      await unlink(full).catch(() => null);
    }
  }
  return n;
}
