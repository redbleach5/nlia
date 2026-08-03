import 'server-only';

// Server: resolve recent episode sandbox for referential follow-ups.
// Pure detectors: artifact-followup-client.ts

import { readdir, stat } from 'fs/promises';
import { listAgentTasks } from './task';
import { displayAgentGoal } from './goal-display';
export {
  isOpenOrShowArtifactGoal,
  isReferentialWorkspaceGoal,
  isFixOrDebugArtifactGoal,
  shouldReuseRecentEpisodeSandbox,
} from './artifact-followup-client';

async function directoryExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reuse fsScope from the latest episode agent task that still has files on disk.
 */
export async function findRecentEpisodeFsScope(episodeId: string): Promise<{
  fsScope: string;
  taskId: string;
  goal: string;
  files: string[];
} | null> {
  const tasks = await listAgentTasks(episodeId, 15);
  for (const t of tasks) {
    if (!t.fsScope || t.fsScope === 'none') continue;
    if (!(await directoryExists(t.fsScope))) continue;
    let files: string[] = [];
    try {
      files = (await readdir(t.fsScope))
        .filter(n => !n.startsWith('.'))
        .slice(0, 20);
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    return {
      fsScope: t.fsScope,
      taskId: t.id,
      goal: displayAgentGoal(t.goal).slice(0, 200),
      files,
    };
  }
  return null;
}
