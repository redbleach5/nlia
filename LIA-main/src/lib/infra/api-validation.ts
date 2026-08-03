import 'server-only';

// ============================================================================
// API validation — zod schemas + helper для всех POST endpoints.
// ============================================================================
//
// Единый `parseBody(req, schema)` с типизированным результатом вместо ad-hoc проверок в routes.

import { NextRequest, NextResponse } from 'next/server';
import { z, type ZodType } from 'zod';
import { normalizeOllamaBaseUrl } from '@/lib/ollama-base-url';

/**
 * Распарсить body запроса через zod schema.
 * Возвращает { success: true, data } или { success: false, response }.
 *
 * Использование:
 *   const result = await parseBody(req, chatRequestSchema);
 *   if (!result.success) return result.response;
 *   const { text, episodeId, mode } = result.data;
 */
export async function parseBody<T>(
  req: NextRequest,
  schema: ZodType<T>,
): Promise<
  | { success: true; data: T }
  | { success: false; response: NextResponse }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'validation failed',
          details: result.error.issues.map(i => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }

  return { success: true, data: result.data };
}

// ============================================================================
// Schemas — по одной на каждый POST endpoint с body.
// ============================================================================

// POST /api/chat — UI modes only (depth is server-side from tier × complexity).
const chatModeSchema = z.enum(['auto', 'agent']);

export const chatRequestSchema = z.object({
  text: z.string().max(100_000, 'message too long').default(''),
  episodeId: z.string().min(1, 'episodeId required'),
  mode: chatModeSchema.default('auto'),
  attachmentIds: z.array(z.string().min(1)).max(5).optional(),
}).refine(
  data => data.text.trim().length > 0 || (data.attachmentIds?.length ?? 0) > 0,
  { message: 'empty message', path: ['text'] },
);

export const chatAttachmentUploadSchema = z.object({
  episodeId: z.string().min(1),
  file: z.custom<{ name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }>(
    v => !!v && typeof v === 'object' && typeof (v as { arrayBuffer?: unknown }).arrayBuffer === 'function',
    { message: 'file required' },
  ),
});

// POST /api/agent (create task)
// P6-1 fix: added `template` field for root-task template selection.
// Previously all root tasks used 'general' template; planner was non-functional.
export const createAgentTaskSchema = z.object({
  episodeId: z.string().min(1),
  goal: z.string().min(1).max(10_000),
  autoStart: z.boolean().default(true),
  fsScope: z.string().nullable().optional(),
  toolsWhitelist: z.array(z.string()).nullable().optional(),
  // Ceiling matches TIER_PARAMS.max.agentMaxSteps (500). Was .max(100), which
  // silently capped plus/max callers below their tier budget.
  maxSteps: z.number().int().min(1).max(500).nullable().optional(),
  // 0 = unbounded duration. Soft budget + wall watchdog skipped.
  maxDurationSec: z.number().int().min(0).max(86400).nullable().optional()
    .refine((v) => v === null || v === undefined || v === 0 || v >= 60, {
      message: 'maxDurationSec must be 0 (unbounded) or >= 60',
    }),
  // P6-1: optional template name. If set, overrides toolsWhitelist/maxSteps/maxDuration
  // with template defaults. 'general' (default) uses caller-provided values.
  template: z.enum([
    'general', 'researcher', 'coder',
  ]).default('general'),
  /** Phase 4: Read / Explore / Edit (auto = infer from goal). */
  workspaceMode: z.enum(['auto', 'read', 'explore', 'edit']).default('auto'),
  /** Confirm writing into an empty sandbox when Edit has no project/KB path. */
  confirmSandbox: z.boolean().optional(),
  /** Ask | auto apply for file writes (sticky client preference). */
  applyMode: z.enum(['ask', 'auto']).optional(),
  /** Optional auto-commit after Apply on git workspaces. */
  gitAutoCommit: z.boolean().optional(),
  /**
   * Skip agent intent gate (chat/ask deferral). Used after user confirms
   * «Запустить агента» on an ambiguous goal, or for trusted follow-ups.
   */
  forceAgent: z.boolean().optional(),
});

// POST /api/agent/[id]/input
// P2-9 fix (T-18): added .max() to prevent unbounded answer length.
// A 10MB answer was previously accepted and stored in DB / fed to LLM.
export const agentInputSchema = z.object({
  answer: z.string().min(1, 'answer required').max(10_000, 'answer too long (max 10000 chars)'),
});

// POST /api/episodes (create)
export const createEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
});

// PATCH /api/episodes/[id]
export const updateEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
});

// PUT /api/episodes/[id]/workspace — bind workspace to episode
export const upsertEpisodeWorkspaceSchema = z.object({
  kind: z.enum(['project', 'kb', 'sandbox']),
  fsPath: z.string().max(1000).nullable().optional(),
  sourceIds: z.array(z.string().min(1).max(64)).max(5).optional(),
  label: z.string().max(120).optional(),
  pinKb: z.boolean().optional(),
});

// POST /api/settings
// AvatarConfig — complex nested, валидируется через parseAvatarConfig в route.
// Здесь валидируем только top-level поля (все optional — partial update).
//
// baseUrl: empty string is treated as "omit" — the Model tab always sends
// baseUrl, and a cleared input must not fail the whole save (otherwise model
// selection looks broken: toast "validation failed", DB unchanged).
// Bare LAN IP / host (e.g. 192.168.1.50) is normalized to http://host:11434.
export const updateSettingsSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null || v.trim() === '') return undefined;
      return normalizeOllamaBaseUrl(v);
    })
    .pipe(
      z.union([
        z.undefined(),
        z.string().url({ message: 'invalid Ollama host URL' }),
      ]),
    ),
  model: z.string().optional(),
  /** Empty string = agent uses the same model as chat. */
  agentModel: z.string().optional(),
  /** Empty string clears secondary (trivial stays on chat). */
  secondaryModel: z.string().optional(),
  /** Empty string clears heavy (escalate no-ops). */
  heavyModel: z.string().optional(),
  embedModel: z.string().optional(),
  /** Coding via Claude Code CLI (Ollama Anthropic API). */
  claudeCodeEnabled: z.boolean().optional(),
  /** Optional model override for Claude Code; empty = agent slot. */
  claudeCodeModel: z.string().optional(),
  /**
   * Ollama.com API key for cloud models (Claude Code path B).
   * Empty string clears the stored key. Omit to leave unchanged.
   */
  ollamaApiKey: z.string().max(512).optional(),
  activeVrm: z.string().nullable().optional(),
  avatarConfig: z.record(z.string(), z.unknown()).optional(),
  /** Empty string clears user.name global fact */
  userDisplayName: z.string().max(80).optional(),
});

// ============================================================================
// Knowledge Base schemas (KB Phase 1+)
// ============================================================================

// POST /api/kb/sources — create source
// config — type-specific JSON, валидируется отдельно в route handler
// (т.к. типы конфига сильно отличаются для document vs folder vs url)
export const createKbSourceSchema = z.object({
  type: z.enum(['document', 'folder', 'url']),
  name: z.string().min(1, 'name required').max(200, 'name too long'),
  config: z.record(z.string(), z.unknown()),
});

// Folder source config
export const folderSourceConfigSchema = z.object({
  folderPath: z.string().min(1, 'folderPath required'),
  watchEnabled: z.boolean().default(true),
  fileCount: z.number().int().min(0).optional(),
  fileHashes: z.record(z.string(), z.string()).optional(),
  projectGroupId: z.string().min(1).optional(),
});

// POST /api/kb/project — unified project (docs folder and/or codebase)
export const createKbProjectSchema = z.object({
  path: z.string().min(1, 'path required'),
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(['auto', 'docs', 'code', 'both']).default('auto'),
  watchEnabled: z.boolean().default(true),
  languages: z.array(z.enum(['typescript', 'javascript', 'python'])).optional(),
});

// POST /api/kb/validate-project — probe path before create
export const validateKbProjectSchema = z.object({
  path: z.string().min(1, 'path required'),
});

// Document source config — валидируется внутри route handler
export const documentSourceConfigSchema = z.object({
  filePath: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().int().min(0),
  contentHash: z.string().optional(),
  originalFilename: z.string().optional(),
});

// URL source config — Phase 7
export const urlSourceConfigSchema = z.object({
  url: z.string().url('url must be a valid URL'),
  title: z.string().optional(),
  contentLength: z.number().int().min(0).optional(),
  contentHash: z.string().optional(),
  fetchedAt: z.string().optional(),
});

// PATCH /api/kb/sources/[id] — partial update (name, status, config)
export const updateKbSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['idle', 'indexing', 'ready', 'error', 'paused']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
