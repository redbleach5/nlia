// POST /api/kb/codebase — legacy create-codebase endpoint.
// Prefer POST /api/kb/project (Settings → «Добавить проект»). Kept for curl /
// scripts; new UI must use /api/kb/project.
//
// Body:
//   {
//     "name": "My Project",
//     "projectPath": "/path/to/project",
//     "languages": ["typescript", "javascript", "python"],  // optional
//     "excludePatterns": ["**/*.test.ts"],                   // optional
//     "watchEnabled": true,                                  // optional, default true
//     "tags": ["work", "main-project"]                       // optional
//   }
//
// Returns:
//   201: { sourceId, message }  — source created, indexing started in background
//   400: { error: "..." }   — invalid path or config
//   500: { error: "..." }   — server error

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { createCodebaseSource } from '@/lib/kb/code-indexer';
import { indexCodebaseSource } from '@/lib/kb/code-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_LANGUAGES = new Set(['typescript', 'javascript', 'python']);

interface CreateCodebaseBody {
  name: string;
  projectPath: string;
  languages?: string[];
  excludePatterns?: string[];
  watchEnabled?: boolean;
  tags?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateCodebaseBody;

    // ── Validation ──
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!body.projectPath || typeof body.projectPath !== 'string') {
      return NextResponse.json({ error: 'projectPath is required' }, { status: 400 });
    }

    // Validate path exists and is a directory
    let resolvedPath: string;
    try {
      const stat = await fs.stat(body.projectPath);
      if (!stat.isDirectory()) {
        return NextResponse.json(
          { error: 'projectPath must be a directory' },
          { status: 400 },
        );
      }
      resolvedPath = await fs.realpath(body.projectPath);
    } catch {
      return NextResponse.json(
        { error: `path does not exist: ${body.projectPath}` },
        { status: 400 },
      );
    }

    // Validate languages
    const languages = body.languages ?? ['typescript', 'javascript', 'python'];
    if (!Array.isArray(languages) || languages.length === 0) {
      return NextResponse.json(
        { error: 'languages must be a non-empty array' },
        { status: 400 },
      );
    }
    for (const lang of languages) {
      if (!ALLOWED_LANGUAGES.has(lang)) {
        return NextResponse.json(
          { error: `unsupported language: ${lang}. Allowed: ${[...ALLOWED_LANGUAGES].join(', ')}` },
          { status: 400 },
        );
      }
    }

    // Basic safety: prevent indexing system directories
    const dangerousPaths = ['/', '/usr', '/bin', '/sbin', '/etc', '/var', '/sys', '/proc', '/dev'];
    if (dangerousPaths.includes(resolvedPath) || dangerousPaths.some(p => resolvedPath.startsWith(p + '/'))) {
      return NextResponse.json(
        { error: 'cannot index system directories' },
        { status: 400 },
      );
    }

    // ── Create source ──
    const sourceId = await createCodebaseSource({
      name: body.name.trim(),
      projectPath: resolvedPath,
      languages,
      excludePatterns: body.excludePatterns,
      watchEnabled: body.watchEnabled ?? true,
      tags: body.tags,
    });

    // ── Trigger indexing in background ──
    indexCodebaseSource(sourceId).catch((e) => {
      logger.error('kb', 'Initial codebase indexing failed', { sourceId }, e);
    });
    const { refreshFolderWatchPaths } = await import('@/lib/kb/file-watcher');
    refreshFolderWatchPaths().catch(() => null);

    return NextResponse.json(
      {
        sourceId,
        message: 'Codebase source created, indexing started in background',
      },
      { status: 201 },
    );
  } catch (e) {
    logger.error('kb', 'POST /api/kb/codebase failed', {}, e);
    return NextResponse.json(
      { error: 'failed to create codebase source', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}

// ============================================================================
// GET — quick status check (для UI polling)
// ============================================================================

export async function GET() {
  try {
    const { db } = await import('@/lib/db');
    const sources = await db.source.findMany({
      where: { type: 'codebase' },
      select: {
        id: true,
        name: true,
        status: true,
        chunkCount: true,
        lastIndexedAt: true,
        errorMessage: true,
        config: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const result = sources.map(s => {
      let fileCount: number | undefined;
      let languages: string[] = [];
      try {
        const config = JSON.parse(s.config) as { fileCount?: number; languages?: string[] };
        fileCount = config.fileCount;
        languages = config.languages ?? [];
      } catch { /* ignore */ }
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        chunkCount: s.chunkCount,
        fileCount,
        languages,
        lastIndexedAt: s.lastIndexedAt,
        errorMessage: s.errorMessage,
      };
    });

    return NextResponse.json({ sources: result });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/codebase failed', {}, e);
    return NextResponse.json({ error: 'failed to list codebase sources' }, { status: 500 });
  }
}
