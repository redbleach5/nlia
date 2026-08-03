// GET  /api/settings — get Ollama settings + available models + avatar config
// POST /api/settings — update Ollama settings + avatar config

import { NextRequest, NextResponse } from 'next/server';
import { getOllamaSettings, setOllamaSettings, checkOllamaHealth, reloadSettings } from '@/lib/ollama';
import { getUserDisplayName, setUserDisplayName } from '@/lib/memory/user-profile';
import { db } from '@/lib/db';
import { PATHS } from '@/lib/paths';
import { existsSync, readdirSync } from 'fs';
import { DEFAULT_AVATAR_CONFIG, parseAvatarConfig, type AvatarConfig } from '@/lib/avatar-config';
import { logger } from '@/lib/logger';
import { parseBody, updateSettingsSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getOllamaSettings();
  const health = await checkOllamaHealth();

  // List available VRM models
  const vrmFiles: string[] = [];
  try {
    if (existsSync(PATHS.publicModels)) {
      vrmFiles.push(...readdirSync(PATHS.publicModels)
        .filter(f => f.toLowerCase().endsWith('.vrm'))
        .map(f => `/models/${f}`));
    }
  } catch { /* ignore */ }

  // Read active VRM from DB
  let activeVrm: string | null = null;
  try {
    const row = await db.setting.findUnique({ where: { key: 'avatar_vrm_path' } });
    activeVrm = row?.value ?? null;
  } catch { /* ignore */ }

  // Avatar customization config (camera, background, animation, body)
  let avatarConfig: AvatarConfig = { ...DEFAULT_AVATAR_CONFIG };
  try {
    const row = await db.setting.findUnique({ where: { key: 'avatar_config' } });
    if (row?.value) {
      avatarConfig = parseAvatarConfig(row.value);
    }
  } catch { /* ignore */ }

  const userDisplayName = await getUserDisplayName();
  const { listPeopleForSettings } = await import('@/lib/memory/user-profile');
  const { MAX_PEOPLE } = await import('@/lib/memory/people');
  const people = await listPeopleForSettings();

  const { getClaudeCodeSettings } = await import('@/lib/agent/claude-code/settings');
  const { detectClaudeBinary } = await import('@/lib/agent/claude-code/detect');
  const { listOllamaCloudModels } = await import('@/lib/ollama-cloud-models');
  const { hasOllamaApiKeyConfigured } = await import('@/lib/ollama-api-key');
  const cc = await getClaudeCodeSettings();
  const binary = await detectClaudeBinary();
  const localModels = health.models ?? [];
  const availableCloudModels = await listOllamaCloudModels({ localTags: localModels });

  return NextResponse.json({
    ...settings,
    claudeCodeEnabled: cc.enabled,
    claudeCodeModel: cc.model,
    claudeBinaryOk: binary.ok,
    claudeBinaryError: binary.ok ? undefined : binary.error,
    ollamaApiKeyConfigured: await hasOllamaApiKeyConfigured(),
    ollamaOk: health.ok,
    ollamaError: health.error,
    availableModels: localModels,
    availableCloudModels,
    availableEmbedModels: localModels.filter(m =>
      m.startsWith('nomic-embed') ||
      m.startsWith('mxbai-embed') ||
      m.startsWith('bge-m3') ||
      m.startsWith('snowflake-arctic-embed') ||
      m.startsWith('bge-') ||
      m.startsWith('e5-')
    ),
    vrmFiles,
    activeVrm,
    avatarConfig,
    userDisplayName,
    people,
    maxPeople: MAX_PEOPLE,
  });
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, updateSettingsSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const ollamaChanged = body.baseUrl !== undefined || body.model !== undefined
      || body.embedModel !== undefined || body.agentModel !== undefined
      || body.secondaryModel !== undefined || body.heavyModel !== undefined;

    // Single write — avoids partial in-memory state if a later field throw mid-loop.
    if (ollamaChanged) {
      await setOllamaSettings({
        baseUrl: body.baseUrl,
        model: body.model,
        agentModel: body.agentModel,
        secondaryModel: body.secondaryModel,
        heavyModel: body.heavyModel,
        embedModel: body.embedModel,
      });
    }

    // Active VRM
    if (body.activeVrm !== undefined && body.activeVrm !== null) {
      await db.setting.upsert({
        where: { key: 'avatar_vrm_path' },
        create: { key: 'avatar_vrm_path', value: body.activeVrm },
        update: { value: body.activeVrm },
      });
    }

    // Avatar customization config — full JSON blob
    if (body.avatarConfig) {
      const merged = parseAvatarConfig(JSON.stringify({
        ...DEFAULT_AVATAR_CONFIG,
        ...body.avatarConfig,
      }));
      await db.setting.upsert({
        where: { key: 'avatar_config' },
        create: { key: 'avatar_config', value: JSON.stringify(merged) },
        update: { value: JSON.stringify(merged) },
      });
    }

    if (body.userDisplayName !== undefined) {
      await setUserDisplayName(body.userDisplayName ?? '');
    }

    if (body.claudeCodeEnabled !== undefined || body.claudeCodeModel !== undefined) {
      const { setClaudeCodeSettings } = await import('@/lib/agent/claude-code/settings');
      await setClaudeCodeSettings({
        enabled: body.claudeCodeEnabled,
        model: body.claudeCodeModel,
      });
    }

    if (body.ollamaApiKey !== undefined) {
      const { setOllamaApiKey } = await import('@/lib/ollama-api-key');
      await setOllamaApiKey(body.ollamaApiKey);
    }

    // Если Ollama-настройки менялись — перечитываем и инвалидируем кэш.
    if (ollamaChanged) {
      await reloadSettings();
      // P1: model roles changed → refresh capability / VRAM budget profile
      const { refreshCapabilityAfterModelChange } = await import('@/lib/capability-profile');
      await refreshCapabilityAfterModelChange();
    }

    // Возвращаем обновлённые настройки + свежий health.
    const settings = await getOllamaSettings();
    const health = await checkOllamaHealth();
    const userDisplayName = await getUserDisplayName();
    const { listPeopleForSettings } = await import('@/lib/memory/user-profile');
    const { MAX_PEOPLE } = await import('@/lib/memory/people');
    const people = await listPeopleForSettings();
    const { getClaudeCodeSettings } = await import('@/lib/agent/claude-code/settings');
    const { detectClaudeBinary } = await import('@/lib/agent/claude-code/detect');
    const { listOllamaCloudModels } = await import('@/lib/ollama-cloud-models');
    const { hasOllamaApiKeyConfigured } = await import('@/lib/ollama-api-key');
    const cc = await getClaudeCodeSettings();
    const binary = await detectClaudeBinary();
    const localModels = health.models ?? [];
    const availableCloudModels = await listOllamaCloudModels({ localTags: localModels });
    return NextResponse.json({
      ...settings,
      claudeCodeEnabled: cc.enabled,
      claudeCodeModel: cc.model,
      claudeBinaryOk: binary.ok,
      claudeBinaryError: binary.ok ? undefined : binary.error,
      ollamaApiKeyConfigured: await hasOllamaApiKeyConfigured(),
      ollamaOk: health.ok,
      ollamaError: health.error,
      availableModels: localModels,
      availableCloudModels,
      availableEmbedModels: localModels.filter(m =>
        m.startsWith('nomic-embed') ||
        m.startsWith('mxbai-embed') ||
        m.startsWith('bge-m3') ||
        m.startsWith('snowflake-arctic-embed') ||
        m.startsWith('bge-') ||
        m.startsWith('e5-')
      ),
      userDisplayName,
      people,
      maxPeople: MAX_PEOPLE,
    });
  } catch (e) {
    logger.error('api', 'POST failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
