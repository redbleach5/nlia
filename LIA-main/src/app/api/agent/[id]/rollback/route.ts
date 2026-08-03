// POST /api/agent/[id]/rollback — restore git HEAD captured before first apply.

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAgentTask } from '@/lib/agent/task';
import { getTaskGitSnapshot, clearTaskGitSnapshot } from '@/lib/agent/git-history';
import { undoAllFileChanges } from '@/lib/agent/file-changes';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const snap = getTaskGitSnapshot(id);
    if (snap && task.fsScope) {
      try {
        // Soft local reset only — never force-push.
        await execFileAsync('git', ['reset', '--hard', snap.headSha], {
          cwd: task.fsScope,
          timeout: 60_000,
          windowsHide: true,
        });
        clearTaskGitSnapshot(id);
        log.info('agent', 'git rollback ok', { sha: snap.headSha.slice(0, 8) });
        return NextResponse.json({ ok: true, kind: 'git', sha: snap.headSha });
      } catch (e) {
        log.warn('agent', 'git rollback failed — falling back to file undo', {}, e);
      }
    }

    const undo = await undoAllFileChanges(id, task.fsScope);
    return NextResponse.json({
      ok: true,
      kind: 'file_undo',
      undone: undo.undone,
      skipped: undo.skipped,
      warning: snap
        ? 'git reset failed; used file-level undo'
        : 'no git snapshot — used file-level undo stack',
    });
  } catch (e) {
    log.error('agent', '/rollback failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
