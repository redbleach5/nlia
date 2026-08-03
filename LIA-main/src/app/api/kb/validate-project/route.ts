// POST /api/kb/validate-project — probe path for docs/code before «Добавить проект»

import { NextRequest, NextResponse } from 'next/server';
import { parseBody, validateKbProjectSchema } from '@/lib/infra/api-validation';
import { probeProjectPath } from '@/lib/kb/project-probe';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, validateKbProjectSchema);
    if (!parsed.success) return parsed.response;

    const probe = probeProjectPath(parsed.data.path);
    return NextResponse.json({
      valid: true,
      ...probe,
      hint: probe.suggestedModes.length === 0
        ? 'В папке нет документов (.md/.txt/.pdf/.docx) и исходников (.ts/.js/.py).'
        : undefined,
    });
  } catch (e) {
    return apiError(400, 'invalid project path', {}, e);
  }
}
