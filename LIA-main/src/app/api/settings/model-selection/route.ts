import { NextRequest, NextResponse } from 'next/server';
import { getSecondaryModelName, setSecondaryModelName } from '@/lib/chat/model-selection';
import { checkOllamaHealth, getOllamaSettings } from '@/lib/ollama';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/settings/model-selection
 *
 * No Model tab UI yet (Cleanup Wave 2): configure via this API — see docs/kb/operations.md.
 * chooseModelForQuery() still uses the Setting when set.
 *
 * Returns current primary + secondary model configuration.
 *
 * Response:
 *   200: {
 *     primary: { model, provider, baseUrl },
 *     secondary: { model: string | null, available: boolean },
 *     availableModels: string[],   // all models currently pulled in Ollama
 *   }
 */
export async function GET() {
  try {
    const settings = await getOllamaSettings();
    const secondary = await getSecondaryModelName();
    const health = await checkOllamaHealth({ timeoutMs: 5_000 });

    return NextResponse.json({
      primary: {
        model: settings.model,
        provider: 'ollama',
        baseUrl: settings.baseUrl,
      },
      secondary: {
        model: secondary,
        available: secondary ? health.models.includes(secondary) : false,
      },
      availableModels: health.models,
    });
  } catch (e) {
    return apiError(500, 'Failed to fetch model selection config', {}, e);
  }
}

/**
 * PUT /api/settings/model-selection
 *
 * Set or clear the secondary model.
 *
 * Body:
 *   { secondaryModel: string | null }
 *
 * Response:
 *   200: { secondary: string | null }
 *   400: missing body
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as { secondaryModel?: string | null };
    if (body.secondaryModel === undefined) {
      return apiError(400, 'Missing secondaryModel in body');
    }
    await setSecondaryModelName(body.secondaryModel);
    // P1: secondary role affects budget snapshot (listed; not resident peak)
    const { refreshCapabilityAfterModelChange } = await import('@/lib/capability-profile');
    await refreshCapabilityAfterModelChange();
    return NextResponse.json({ secondary: body.secondaryModel });
  } catch (e) {
    return apiError(500, 'Failed to set secondary model', {}, e);
  }
}
