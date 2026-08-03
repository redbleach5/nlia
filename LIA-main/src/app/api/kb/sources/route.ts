// GET  /api/kb/sources — list all KB sources
// POST /api/kb/sources — create new source (document, folder, url)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  parseBody,
  createKbSourceSchema,
  documentSourceConfigSchema,
  folderSourceConfigSchema,
  urlSourceConfigSchema,
} from '@/lib/infra/api-validation';
import type { DocumentSourceConfig, FolderSourceConfig, UrlSourceConfig, SourceType } from '@/lib/kb/types';
import { resolveFolderPath, countSupportedFiles, buildFolderConfig } from '@/lib/kb/folder-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sources = await db.source.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        type: true,
        name: true,
        config: true,
        status: true,
        lastIndexedAt: true,
        chunkCount: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ sources });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/sources failed', {}, e);
    return NextResponse.json({ error: 'failed to list sources' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, createKbSourceSchema);
    if (!parsed.success) return parsed.response;
    const { type, name, config } = parsed.data;

    let configString: string;
    if (type === 'document') {
      const docCfg = documentSourceConfigSchema.safeParse(config);
      if (!docCfg.success) {
        return NextResponse.json(
          { error: 'invalid document config', details: docCfg.error.issues },
          { status: 400 },
        );
      }
      configString = JSON.stringify(docCfg.data satisfies DocumentSourceConfig);
    } else if (type === 'folder') {
      const folderCfg = folderSourceConfigSchema.safeParse(config);
      if (!folderCfg.success) {
        return NextResponse.json(
          { error: 'invalid folder config', details: folderCfg.error.issues },
          { status: 400 },
        );
      }
      let resolvedPath: string;
      try {
        resolvedPath = resolveFolderPath(folderCfg.data.folderPath);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'invalid folder path';
        return NextResponse.json({ error: message }, { status: 400 });
      }
      const fileCount = countSupportedFiles(resolvedPath);
      if (fileCount === 0) {
        return NextResponse.json(
          { error: 'В папке нет поддерживаемых файлов (.md, .txt, .pdf, .docx)' },
          { status: 400 },
        );
      }
      configString = JSON.stringify({
        ...buildFolderConfig(resolvedPath, fileCount),
        indexMode: 'manifest',
      } satisfies FolderSourceConfig);
    } else if (type === 'url') {
      const urlCfg = urlSourceConfigSchema.safeParse(config);
      if (!urlCfg.success) {
        return NextResponse.json(
          { error: 'invalid url config', details: urlCfg.error.issues },
          { status: 400 },
        );
      }
      configString = JSON.stringify(urlCfg.data satisfies UrlSourceConfig);
    } else {
      const _exhaustive: never = type;
      return NextResponse.json({ error: `unsupported type: ${_exhaustive}` }, { status: 400 });
    }

    const source = await db.source.create({
      data: {
        type: type as SourceType,
        name,
        config: configString,
        status: 'idle',
      },
    });

    logger.info('kb', 'Source created', { sourceId: source.id, type, name });

    if (type === 'document') {
      const { indexDocumentSource } = await import('@/lib/kb/indexer');
      indexDocumentSource(source.id).catch((e) => {
        logger.error('kb', 'Initial document indexing failed', { sourceId: source.id }, e);
      });
    } else if (type === 'folder') {
      const { indexFolderSource } = await import('@/lib/kb/folder-indexer');
      const { refreshFolderWatchPaths } = await import('@/lib/kb/file-watcher');
      indexFolderSource(source.id).catch((e) => {
        logger.error('kb', 'Initial folder indexing failed', { sourceId: source.id }, e);
      });
      refreshFolderWatchPaths().catch(() => null);
    } else if (type === 'url') {
      const { indexUrlSource } = await import('@/lib/kb/indexer');
      indexUrlSource(source.id).catch((e) => {
        logger.error('kb', 'Initial URL indexing failed', { sourceId: source.id }, e);
      });
    }

    return NextResponse.json({ source }, { status: 201 });
  } catch (e) {
    logger.error('kb', 'POST /api/kb/sources failed', {}, e);
    return NextResponse.json({ error: 'failed to create source' }, { status: 500 });
  }
}
