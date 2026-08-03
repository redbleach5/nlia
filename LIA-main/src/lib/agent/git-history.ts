import 'server-only';

/**
 * Git / snapshot helpers for agent apply history (P8).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export type AgentGitSnapshot = {
  kind: 'git';
  headSha: string;
  createdAt: number;
};

const snapshots = new Map<string, AgentGitSnapshot>();

export function getTaskGitSnapshot(taskId: string): AgentGitSnapshot | undefined {
  return snapshots.get(taskId);
}

export async function isGitRepo(fsScope: string): Promise<boolean> {
  try {
    await access(join(fsScope, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Record HEAD before first apply (no working-tree mutation). */
export async function capturePreApplyGitSnapshot(
  taskId: string,
  fsScope: string,
): Promise<AgentGitSnapshot | null> {
  if (snapshots.has(taskId)) return snapshots.get(taskId)!;
  if (!(await isGitRepo(fsScope))) return null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fsScope,
      timeout: 10_000,
      windowsHide: true,
    });
    const headSha = stdout.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(headSha)) return null;
    const snap: AgentGitSnapshot = { kind: 'git', headSha, createdAt: Date.now() };
    snapshots.set(taskId, snap);
    return snap;
  } catch (e) {
    logger.debug('agent', 'git snapshot failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function optionalCommitAfterApply(params: {
  fsScope: string;
  message: string;
  enabled: boolean;
}): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (!params.enabled) return { ok: true };
  if (!(await isGitRepo(params.fsScope))) {
    return { ok: false, error: 'not a git repo' };
  }
  try {
    await execFileAsync('git', ['add', '-A'], {
      cwd: params.fsScope,
      timeout: 30_000,
      windowsHide: true,
    });
    const msg = params.message.slice(0, 180) || 'lia: agent apply';
    await execFileAsync('git', ['commit', '-m', msg, '--allow-empty'], {
      cwd: params.fsScope,
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Lia',
        GIT_AUTHOR_EMAIL: 'lia@local',
        GIT_COMMITTER_NAME: 'Lia',
        GIT_COMMITTER_EMAIL: 'lia@local',
      },
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: params.fsScope,
      timeout: 10_000,
      windowsHide: true,
    });
    return { ok: true, sha: stdout.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/** Soft rollback hint — does not force-reset dirty trees without explicit confirm API. */
export async function suggestRollbackSha(taskId: string): Promise<string | null> {
  return snapshots.get(taskId)?.headSha ?? null;
}

export function clearTaskGitSnapshot(taskId: string) {
  snapshots.delete(taskId);
}
