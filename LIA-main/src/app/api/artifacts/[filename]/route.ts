// GET /api/artifacts/[filename] — download an artifact saved by save_artifact

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { PATHS } from '@/lib/paths';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// MIME types for common artifact extensions
const MIME_MAP: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Security: use path.basename to strip any directory components.
  // This prevents path traversal (../../../etc/passwd).
  // Then check the basename matches the original (no directory parts).
  const basename = path.basename(filename);
  if (basename !== filename || basename.startsWith('.')) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
  }

  // Additional check: no path separators or parent references
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
  }

  const filePath = path.join(PATHS.artifacts, basename);

  try {
    const buf = await readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_MAP[ext] ?? 'application/octet-stream';

    return new Response(buf, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${basename}"`,
        // P3-2 fix: shorter cache (was 3600s) — artifacts may be replaced.
        'Cache-Control': 'private, max-age=60',
        // P3-2 fix (M-DB-16.2): prevent MIME-sniffing — browsers may otherwise
        // execute content as a different type (e.g. SVG with <script>).
        'X-Content-Type-Options': 'nosniff',
        // P3-2 fix: for HTML artifacts, sandbox without scripts — prevent XSS
        // if user opens the artifact in a browser tab.
        ...(mime === 'text/html' ? {
          'Content-Security-Policy': 'sandbox',
        } : {}),
      },
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
    }
    logger.error('api', 'read failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
