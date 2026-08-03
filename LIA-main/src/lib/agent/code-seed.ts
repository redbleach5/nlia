import 'server-only';

import { readFile, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join } from 'path';
import { PATHS } from '@/lib/paths';
import { isCodeExplorationGoal, isKbAssistedGoal } from './kb-step-utils';
import { isProjectRootFsScope } from './workspace-scope';

const KEY_FILES = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'src/lib/agent/runner.ts',
  'src/lib/agent/runner-helpers.ts',
  'src/lib/agent/kb-step-utils.ts',
  'src/lib/chat/pipeline.ts',
  'src/lib/agent/tools.ts',
] as const;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed context for code-exploration goals — ARCHITECTURE + existing key paths.
 * Only when fsScope is the Lia project root. External workspaces (e.g. AgentsRise)
 * must not get Lia entry-point hints or the agent will chase missing paths.
 */
export async function buildCodeExplorationSeed(
  goal: string,
  fsScope?: string | null,
): Promise<string> {
  if (!isCodeExplorationGoal(goal) && !isKbAssistedGoal(goal)) return '';
  // Only seed when fsScope is explicitly Lia root — never on undefined/null/external.
  if (!isProjectRootFsScope(fsScope)) return '';

  const parts: string[] = [
    'Карта кода (начни отсюда, не ограничивайся docs/ARCHITECTURE.md):',
    'Инструменты: grep(pattern) → read_file по hit; list_tree для обзора.',
  ];

  const entryPath = join(PATHS.root, 'docs', 'ARCHITECTURE.md');
  if (await pathExists(entryPath)) {
    try {
      const raw = await readFile(entryPath, 'utf8');
      parts.push('--- docs/ARCHITECTURE.md ---\n' + raw.slice(0, 2800));
    } catch {
      /* ignore */
    }
  }

  const existing: string[] = [];
  for (const rel of KEY_FILES) {
    if (await pathExists(join(PATHS.root, rel))) existing.push(rel);
  }
  if (existing.length > 0) {
    parts.push(
      'Ключевые файлы (существуют на диске — читай через read_file):\n'
      + existing.map((p) => `- ${p}`).join('\n'),
    );
  }

  return parts.join('\n\n');
}
