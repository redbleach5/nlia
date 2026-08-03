// GET /api/episodes/[id]/workspace/probe — rules source + flat path list for @ picker.

import { NextRequest, NextResponse } from 'next/server';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getEpisode } from '@/lib/memory/episodes';
import { getEpisodeWorkspace } from '@/lib/agent/workspace-binding';
import { loadWorkspaceRules } from '@/lib/agent/rules-loader';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.turbo']);
const MAX_PATHS = 400;
const MAX_DEPTH = 4;

async function collectPaths(
  dirPath: string,
  basePath: string,
  depth: number,
  out: { path: string; kind: 'file' | 'folder' }[],
): Promise<void> {
  if (depth >= MAX_DEPTH || out.length >= MAX_PATHS) return;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_PATHS) return;
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const entryPath = join(dirPath, entry.name);
    const rel = entryPath.slice(basePath.length + 1).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push({ path: rel, kind: 'folder' });
      await collectPaths(entryPath, basePath, depth + 1, out);
    } else if (entry.isFile()) {
      const s = await stat(entryPath).catch(() => null);
      if (s && s.size > 2_000_000) continue;
      out.push({ path: rel, kind: 'file' });
    }
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const episode = await getEpisode(id);
    if (!episode) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const binding = await getEpisodeWorkspace(id);
    const fsPath = binding?.fsPath?.trim() || null;

    let rulesSource: string | null = null;
    let paths: { path: string; kind: 'file' | 'folder' }[] = [];

    if (fsPath) {
      const rules = await loadWorkspaceRules(fsPath).catch(() => ({ text: '', source: null }));
      rulesSource = rules.source;
      await collectPaths(fsPath, fsPath, 0, paths);
    }

    return NextResponse.json({
      binding,
      rulesSource,
      hasRules: Boolean(rulesSource),
      paths,
    });
  } catch (e) {
    logger.error('api', 'GET workspace probe failed', { episodeId: id.slice(0, 8) }, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
