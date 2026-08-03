// POST /api/kb/validate-folder — проверить путь к папке перед добавлением в KB

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/infra/api-validation';
import { resolveFolderPath, countSupportedFiles, countLegacyDocFiles, folderFileCountHint } from '@/lib/kb/folder-utils';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  folderPath: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, schema);
    if (!parsed.success) return parsed.response;

    const resolved = resolveFolderPath(parsed.data.folderPath);
    const fileCount = countSupportedFiles(resolved);
    const legacyDocCount = countLegacyDocFiles(resolved);

    return NextResponse.json({
      valid: true,
      folderPath: resolved,
      fileCount,
      legacyDocCount,
      hint: legacyDocCount > 0 && fileCount === 0
        ? `Найдено ${legacyDocCount} файлов .doc — формат не поддерживается. Сохраните как .docx или .pdf.`
        : folderFileCountHint(fileCount) ?? undefined,
    });
  } catch (e) {
    // P2-2 fix (M-X-5): don't leak filesystem path info — return generic 400.
    // Folder validation failures are expected (user typos, etc.) — use 400
    // not 500, and log details server-side only.
    return apiError(400, 'invalid folder path', {}, e);
  }
}
