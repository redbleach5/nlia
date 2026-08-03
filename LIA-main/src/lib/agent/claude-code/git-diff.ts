import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { isGitRepo } from '../git-history';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export type CcFileDiff = {
  path: string;
  diff: string;
  tool: 'edit_file' | 'write_file';
};

/** List changed files + unified diffs since HEAD (or empty tree). */
export async function collectGitDiffsSinceHead(fsScope: string): Promise<CcFileDiff[]> {
  if (!(await isGitRepo(fsScope))) return [];
  try {
    const { stdout: nameOut } = await execFileAsync(
      'git',
      ['diff', '--name-only', 'HEAD'],
      { cwd: fsScope, timeout: 30_000, windowsHide: true },
    );
    const { stdout: untrackedOut } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: fsScope, timeout: 30_000, windowsHide: true },
    );
    const paths = [
      ...nameOut.split('\n'),
      ...untrackedOut.split('\n'),
    ]
      .map((p) => p.trim())
      .filter(Boolean);

    const unique = [...new Set(paths)];
    const diffs: CcFileDiff[] = [];
    for (const path of unique.slice(0, 40)) {
      let diff = '';
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', 'HEAD', '--', path],
          { cwd: fsScope, timeout: 15_000, windowsHide: true, maxBuffer: 2_000_000 },
        );
        diff = stdout;
        if (!diff.trim()) {
          // New untracked file — show as added content preview via diff --no-index
          const { stdout: addDiff } = await execFileAsync(
            'git',
            ['diff', '--no-index', '--', '/dev/null', path],
            { cwd: fsScope, timeout: 15_000, windowsHide: true, maxBuffer: 2_000_000 },
          ).catch(async () => {
            // Windows: use NUL
            try {
              const r = await execFileAsync(
                'git',
                ['diff', '--no-index', '--', 'NUL', path],
                { cwd: fsScope, timeout: 15_000, windowsHide: true, maxBuffer: 2_000_000 },
              );
              return r;
            } catch {
              return { stdout: '' };
            }
          });
          diff = addDiff;
        }
      } catch (e) {
        logger.debug('agent', 'cc git diff file failed', { path });
      }
      diffs.push({
        path,
        diff: (diff || '').slice(0, 12_000),
        tool: diff.includes('new file') || diff.includes('/dev/null') || diff.includes('NUL')
          ? 'write_file'
          : 'edit_file',
      });
    }
    return diffs;
  } catch (e) {
    logger.warn('agent', 'collectGitDiffsSinceHead failed');
    return [];
  }
}

export function changeIdForPath(taskId: string, path: string): string {
  return createHash('sha256').update(`${taskId}:${path}`).digest('hex').slice(0, 16)
    || randomUUID().slice(0, 16);
}
