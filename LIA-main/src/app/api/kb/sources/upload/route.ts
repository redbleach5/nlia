// POST /api/kb/sources/upload — multipart document upload for KB.
//
// Saves file to PATHS.artifacts/kb-uploads/, creates Source(type=document),
// starts indexDocumentSource in background. UI + kb-chat-e2e expect this path;
// without it Next matches /api/kb/sources/[id] with id="upload" → 405.

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { saveUploadedFile } from '@/lib/kb/indexer';
import type { DocumentSourceConfig } from '@/lib/kb/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB — same as VRM; see docs/kb/operations.md

/** Extension → canonical MIME (browser Content-Type is often wrong/empty). */
const EXT_TO_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

const ALLOWED_MIMES = new Set(Object.values(EXT_TO_MIME));

function resolveMime(filename: string, reported: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const fromExt = EXT_TO_MIME[ext];
  if (fromExt) return fromExt;

  const mime = (reported || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_MIMES.has(mime)) return mime;
  return null;
}

/** Light magic-byte checks for binary formats (ops.md / upload-vrm pattern). */
function assertMagicBytes(mime: string, buf: Buffer): string | null {
  if (mime === 'application/pdf') {
    if (buf.length < 5 || buf.subarray(0, 5).toString('utf8') !== '%PDF-') {
      return 'Invalid PDF: missing %PDF- header';
    }
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword'
  ) {
    // DOCX is a ZIP; legacy .doc often starts with OLE compound header D0 CF 11 E0
    const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
    const isOle =
      buf.length >= 4 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0;
    if (!isZip && !isOle) {
      return 'Invalid Word document: expected ZIP (DOCX) or OLE (.doc) header';
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const rawName = formData.get('name');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name required' }, { status: 400 });
    }
    if (name.length > 200) {
      return NextResponse.json({ error: 'name too long' }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        {
          error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max ${MAX_UPLOAD_SIZE / 1024 / 1024} MB.`,
        },
        { status: 413 },
      );
    }

    const mimeType = resolveMime(file.name, file.type);
    if (!mimeType) {
      return NextResponse.json(
        {
          error:
            'Unsupported file type. Allowed: .md, .txt, .pdf, .docx (and legacy .doc)',
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const magicErr = assertMagicBytes(mimeType, buffer);
    if (magicErr) {
      return NextResponse.json({ error: magicErr }, { status: 400 });
    }

    const { filePath, contentHash, fileSize } = await saveUploadedFile(file.name, buffer);

    const config: DocumentSourceConfig = {
      filePath,
      mimeType,
      fileSize,
      contentHash,
      originalFilename: file.name,
    };

    const source = await db.source.create({
      data: {
        type: 'document',
        name,
        config: JSON.stringify(config),
        status: 'idle',
      },
    });

    logger.info('kb', 'Document uploaded', {
      sourceId: source.id.slice(0, 8),
      name,
      mimeType,
      fileSize,
    });

    const { indexDocumentSource } = await import('@/lib/kb/indexer');
    indexDocumentSource(source.id).catch((e) => {
      logger.error('kb', 'Initial document indexing failed', { sourceId: source.id }, e);
    });

    return NextResponse.json({ source }, { status: 201 });
  } catch (e) {
    logger.error('kb', 'POST /api/kb/sources/upload failed', {}, e);
    return NextResponse.json({ error: 'upload failed' }, { status: 500 });
  }
}
