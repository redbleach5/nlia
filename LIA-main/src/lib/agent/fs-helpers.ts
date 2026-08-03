import 'server-only';

import { readdir } from 'fs/promises';
import { join } from 'path';
import { safePathWithinScope } from './fs-scope';
import type { AgentTask } from './task';

const FS_SKIP_NAMES = new Set(['node_modules', '__pycache__']);

export function shouldSkipFsEntry(name: string): boolean {
  return name.startsWith('.') || FS_SKIP_NAMES.has(name);
}

type ScopedPathResult =
  | { ok: true; fullPath: string }
  | { ok: false; error: string };

export async function resolveScopedPath(
  task: AgentTask,
  relativePath: string,
  deniedMessage: string,
): Promise<ScopedPathResult> {
  if (!task.fsScope) {
    return { ok: false, error: deniedMessage };
  }
  const fullPath = await safePathWithinScope(relativePath, task.fsScope);
  if (!fullPath) {
    return { ok: false, error: `Путь "${relativePath}" выходит за пределы рабочей директории` };
  }
  return { ok: true, fullPath };
}

type WalkEntry = {
  fullPath: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  isFile: boolean;
};

export async function walkScope(
  rootFullPath: string,
  handler: (entry: WalkEntry) => Promise<void | 'stop'>,
  options?: { maxDepth?: number; relativePrefix?: string },
): Promise<void> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const prefix = options?.relativePrefix ?? '';

  async function walk(dirPath: string, relPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipFsEntry(entry.name)) continue;
      if (entry.isSymbolicLink?.()) continue;

      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const entryPath = join(dirPath, entry.name);
      const walkEntry: WalkEntry = {
        fullPath: entryPath,
        relativePath: entryRel,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      };

      const result = await handler(walkEntry);
      if (result === 'stop') return;

      if (entry.isDirectory()) {
        await walk(entryPath, entryRel, depth + 1);
      }
    }
  }

  await walk(rootFullPath, prefix, 0);
}

const TEXT_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'json', 'md', 'txt', 'yaml', 'yml', 'sh', 'css', 'html', 'sql', 'prisma',
]);

export function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && TEXT_FILE_EXTENSIONS.has(ext);
}
