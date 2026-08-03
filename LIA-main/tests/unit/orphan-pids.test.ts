import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  persistRuntimePid,
  clearRuntimePid,
  sweepOrphanRuntimes,
  killProcessTreeByPid,
  isProcessAlive,
} from '@/lib/agent/runtime/orphan-pids';

describe('orphan runtime pids', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('sweepOrphanRuntimes is no-op when pid dir missing', async () => {
    const n = await sweepOrphanRuntimes(join(tmpdir(), `lia-missing-${Date.now()}`));
    expect(n).toBe(0);
  });

  it('killProcessTreeByPid stops a live child', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid!;
    expect(isProcessAlive(pid)).toBe(true);
    await killProcessTreeByPid(pid);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('sweep kills persisted pid and removes file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lia-orphan-'));
    dirs.push(dir);

    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid!;

    await persistRuntimePid(
      { taskId: 'task-abc', pid, port: 5173, startedAt: Date.now() },
      dir,
    );

    const n = await sweepOrphanRuntimes(dir);
    expect(n).toBe(1);
    expect(isProcessAlive(pid)).toBe(false);

    await clearRuntimePid('task-abc', dir);
    expect(await sweepOrphanRuntimes(dir)).toBe(0);
  });
});
