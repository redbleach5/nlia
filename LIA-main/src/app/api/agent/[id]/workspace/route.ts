// GET /api/agent/[id]/workspace — file tree + content for the workspace UI.
//
// Returns the file tree of the agent's fsScope (if set) and optionally
// the content of a specific file (?file=path).
//
// fsScope comes from resolveAgentFsScope (explicit / env / KB / Lia self / sandbox).
// Sandbox lives under agent-workspaces/.

import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { getAgentTask } from '@/lib/agent/task';
import { safePathWithinScope } from '@/lib/agent/fs-scope';
import { isProjectRootFsScope } from '@/lib/agent/workspace-scope';
import { logger } from '@/lib/logger';

function workspaceKind(fsScope: string): 'project' | 'sandbox' | 'custom' {
  if (isProjectRootFsScope(fsScope)) return 'project';
  if (/agent-workspaces[/\\]/i.test(fsScope)) return 'sandbox';
  return 'custom';
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TreeNode = {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: TreeNode[];
};

async function buildTree(dirPath: string, basePath: string, depth: number, maxDepth: number): Promise<TreeNode[]> {
  if (depth >= maxDepth) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

    const entryPath = join(dirPath, entry.name);
    const relPath = entryPath.slice(basePath.length + 1).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      const children = await buildTree(entryPath, basePath, depth + 1, maxDepth).catch(() => []);
      nodes.push({ name: entry.name, path: relPath, type: 'dir', children });
    } else if (entry.isFile()) {
      const s = await stat(entryPath).catch(() => null);
      nodes.push({ name: entry.name, path: relPath, type: 'file', size: s?.size });
    }
  }
  return nodes;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'task not found' }, { status: 404 });
    }

    if (!task.fsScope) {
      return NextResponse.json({
        tree: [],
        fileContent: null,
        hasWorkspace: false,
        kind: null,
        label: null,
        fsScope: null,
      });
    }

    const kind = workspaceKind(task.fsScope);
    const label = basename(task.fsScope.replace(/[/\\]+$/, '')) || task.fsScope;

    // Build file tree
    const tree = await buildTree(task.fsScope, task.fsScope, 0, 4).catch(() => []);

    // Optionally get file content
    const filePath = req.nextUrl.searchParams.get('file');
    let fileContent: string | null = null;
    let fileError: string | null = null;

    if (filePath) {
      // Security: path traversal protection via safePathWithinScope.
      // Решает symlink-атаки и Windows-сепараторы (`..\etc\passwd` обходил
      // старую проверку `slice + startsWith('..')`).
      const safePath = await safePathWithinScope(filePath, task.fsScope);
      if (!safePath) {
        fileError = 'path traversal detected or file outside workspace';
      } else {
        try {
          const s = await stat(safePath);
          if (s.size > 100_000) {
            fileError = 'file too large (max 100KB)';
          } else {
            fileContent = await readFile(safePath, 'utf8');
          }
        } catch {
          fileError = 'file not found';
        }
      }
    }

    return NextResponse.json({
      tree,
      fileContent,
      fileError,
      hasWorkspace: true,
      fsScope: task.fsScope,
      kind,
      label,
    });
  } catch (e) {
    logger.error('agent', '/workspace] failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
