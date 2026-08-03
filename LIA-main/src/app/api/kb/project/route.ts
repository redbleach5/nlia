// POST /api/kb/project — create folder and/or codebase sources for one project path.
//
// Pipelines stay separate (manifest docs vs AST code). UX is unified: one dialog,
// shared projectGroupId links sibling sources.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseBody, createKbProjectSchema } from '@/lib/infra/api-validation';
import { buildFolderConfig } from '@/lib/kb/folder-utils';
import { probeProjectPath, resolveProjectModes } from '@/lib/kb/project-probe';
import { createCodebaseSource, indexCodebaseSource } from '@/lib/kb/code-indexer';
import { indexFolderSource } from '@/lib/kb/folder-indexer';
import { refreshFolderWatchPaths } from '@/lib/kb/file-watcher';
import type { FolderSourceConfig } from '@/lib/kb/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DANGEROUS_PATHS = ['/', '/usr', '/bin', '/sbin', '/etc', '/var', '/sys', '/proc', '/dev'];

function isDangerousPath(resolved: string): boolean {
  if (DANGEROUS_PATHS.includes(resolved)) return true;
  return DANGEROUS_PATHS.some(p => resolved.startsWith(`${p}/`));
}

function defaultProjectName(resolvedPath: string, name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const base = path.basename(resolvedPath);
  return base || 'Проект';
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, createKbProjectSchema);
    if (!parsed.success) return parsed.response;

    const { path: inputPath, name, mode, watchEnabled, languages } = parsed.data;

    let probe;
    try {
      probe = probeProjectPath(inputPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'invalid path';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (isDangerousPath(probe.path)) {
      return NextResponse.json({ error: 'cannot index system directories' }, { status: 400 });
    }

    const { modes, warnings } = resolveProjectModes(mode, probe);
    if (modes.length === 0) {
      return NextResponse.json(
        {
          error: 'В папке нет подходящих файлов для выбранного режима',
          probe,
          warnings,
        },
        { status: 400 },
      );
    }

    const projectGroupId = randomUUID();
    const displayName = defaultProjectName(probe.path, name);
    const created: Array<{ id: string; type: string; name: string; status: string }> = [];

    if (modes.includes('docs')) {
      const folderName = modes.includes('code') ? `${displayName} (документы)` : displayName;
      const config: FolderSourceConfig = {
        ...buildFolderConfig(probe.path, probe.docFiles),
        indexMode: 'manifest',
        watchEnabled,
        projectGroupId,
      };
      const source = await db.source.create({
        data: {
          type: 'folder',
          name: folderName,
          config: JSON.stringify(config),
          status: 'idle',
        },
      });
      created.push({
        id: source.id,
        type: source.type,
        name: source.name,
        status: source.status,
      });
      indexFolderSource(source.id).catch((e) => {
        logger.error('kb', 'Initial folder indexing failed (project)', { sourceId: source.id }, e);
      });
    }

    if (modes.includes('code')) {
      const codeName = modes.includes('docs') ? `${displayName} (код)` : displayName;
      const sourceId = await createCodebaseSource({
        name: codeName,
        projectPath: probe.path,
        languages: languages ?? ['typescript', 'javascript', 'python'],
        watchEnabled,
        projectGroupId,
      });
      created.push({
        id: sourceId,
        type: 'codebase',
        name: codeName,
        status: 'idle',
      });
      indexCodebaseSource(sourceId).catch((e) => {
        logger.error('kb', 'Initial codebase indexing failed (project)', { sourceId }, e);
      });
    }

    refreshFolderWatchPaths().catch(() => null);

    logger.info('kb', 'Project sources created', {
      projectGroupId: projectGroupId.slice(0, 8),
      modes,
      count: created.length,
      path: probe.path,
    });

    return NextResponse.json(
      {
        projectGroupId,
        sources: created,
        probe,
        warnings: warnings.length > 0 ? warnings : undefined,
        message: 'Проект добавлен, индексация запущена в фоне',
      },
      { status: 201 },
    );
  } catch (e) {
    logger.error('kb', 'POST /api/kb/project failed', {}, e);
    return NextResponse.json(
      { error: 'failed to create project', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
