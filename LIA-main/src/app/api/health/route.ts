// GET /api/health — Ollama health check

import { NextResponse } from 'next/server';
import { checkOllamaHealth, getOllamaSettings } from '@/lib/ollama';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getOllamaSettings();
    const health = await checkOllamaHealth();
    return NextResponse.json({
      ...health,
      baseUrl: settings.baseUrl,
      model: settings.model,
      embedModel: settings.embedModel,
    });
  } catch (e) {
    // P2-2 fix (M-X-5): use apiError to avoid leaking internal error details.
    return apiError(500, 'health check failed', {}, e);
  }
}
