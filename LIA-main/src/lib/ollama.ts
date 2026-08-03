import 'server-only';

// LLM provider — Ollama (local).
//
// AI SDK gives us:
//   - streamText with tool calling (one LLM call does decideTool + speak + execute)
//   - automatic retry on rate limits
//   - prefix caching (Ollama's KV-cache)
//   - structured outputs via Zod schemas
//
// Chat + embeddings both go through Ollama.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { db } from './db';
import { logger } from './logger';
import { resolveAgentModelName } from './llm/resolve-agent-model';
import { reconcileOllamaEnvAndDb, mirrorOllamaToProcessEnv } from './infra/ollama-env-sync';
import { normalizeOllamaBaseUrl } from './ollama-base-url';

/** Active Ollama num_ctx for /v1 chat completions (single-user; set per stream). */
let activeOllamaNumCtx: number | undefined;
/** Active keep_alive for Ollama options (e.g. heavy escalate → "0"). */
let activeOllamaKeepAlive: string | number | undefined;

/** Set explicit num_ctx injected into Ollama OpenAI-compatible requests. */
export function setOllamaNumCtx(numCtx: number | undefined): void {
  activeOllamaNumCtx = numCtx;
}

/**
 * Set keep_alive for subsequent Ollama chat completions.
 * Heavy escalate uses short/"0" so day VRAM is not stolen indefinitely.
 */
export function setOllamaKeepAlive(keepAlive: string | number | undefined): void {
  activeOllamaKeepAlive = keepAlive;
}

export function getOllamaKeepAlive(): string | number | undefined {
  return activeOllamaKeepAlive;
}

// ============================================================================
// Settings persistence — load from DB on first call.
// ============================================================================

const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const DEFAULT_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
/** Optional stronger model for agent plan/execute/synthesize. Empty = same as chat. */
const DEFAULT_AGENT_MODEL = process.env.OLLAMA_AGENT_MODEL || '';
/** Optional heavy model for escalate. Empty = fall back to agent/chat. */
const DEFAULT_HEAVY_MODEL = process.env.OLLAMA_HEAVY_MODEL || '';

let currentBaseUrl = DEFAULT_BASE_URL;
let currentModel = DEFAULT_MODEL;
/** Empty string = agent uses the same model as chat. */
let currentAgentModel = DEFAULT_AGENT_MODEL;
/** Empty string = secondary unset (trivial path stays on chat). */
let currentSecondaryModel = '';
/** Empty string = heavy unset (escalate no-ops). */
let currentHeavyModel = DEFAULT_HEAVY_MODEL;
let currentEmbedModel = DEFAULT_EMBED_MODEL;
let settingsLoaded = false;
let settingsLoadedAt = 0;
let settingsLoadPromise: Promise<void> | null = null;
/** Short TTL so chat/settings GET pick up DB writes after UI save (HMR / multi-route). */
const SETTINGS_CACHE_TTL_MS = 1_000;

async function loadSettings(): Promise<void> {
  if (settingsLoaded && Date.now() - settingsLoadedAt < SETTINGS_CACHE_TTL_MS) return;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    try {
      const rows = await db.setting.findMany();
      let changed = false;
      // Reset role defaults before applying DB so deleted keys don't stick.
      // Agent/embed may be absent — defaults applied below.
      // Legacy keys llm_provider / groq_* are ignored if still present in DB.
      let nextBaseUrl = DEFAULT_BASE_URL;
      let nextModel = DEFAULT_MODEL;
      let nextAgentModel = DEFAULT_AGENT_MODEL;
      let nextSecondaryModel = '';
      let nextHeavyModel = DEFAULT_HEAVY_MODEL;
      // Absent embed key = auto (not DEFAULT_EMBED_MODEL) — matches UI "Авто".
      let nextEmbedModel = '';

      for (const row of rows) {
        if (row.key === 'ollama_base_url' && row.value) {
          nextBaseUrl = row.value;
        } else if (row.key === 'ollama_model' && row.value) {
          nextModel = row.value;
        } else if (row.key === 'ollama_agent_model') {
          nextAgentModel = row.value;
        } else if (row.key === 'ollama_secondary_model') {
          nextSecondaryModel = row.value;
        } else if (row.key === 'ollama_heavy_model') {
          nextHeavyModel = row.value;
        } else if (row.key === 'ollama_embed_model' && row.value) {
          nextEmbedModel = row.value;
        }
      }

      changed =
        nextBaseUrl !== currentBaseUrl
        || nextModel !== currentModel
        || nextAgentModel !== currentAgentModel
        || nextSecondaryModel !== currentSecondaryModel
        || nextHeavyModel !== currentHeavyModel
        || nextEmbedModel !== currentEmbedModel;

      currentBaseUrl = nextBaseUrl;
      currentModel = nextModel;
      currentAgentModel = nextAgentModel;
      currentSecondaryModel = nextSecondaryModel;
      currentHeavyModel = nextHeavyModel;
      currentEmbedModel = nextEmbedModel;

      settingsLoaded = true;
      settingsLoadedAt = Date.now();
      if (changed) {
        logger.debug('llm', 'Settings loaded from DB', {
          baseUrl: currentBaseUrl,
          model: currentModel,
          agentModel: currentAgentModel || '(same as chat)',
          secondaryModel: currentSecondaryModel || '(none)',
          heavyModel: currentHeavyModel || '(none)',
          embedModel: currentEmbedModel || 'auto',
        });
      }
    } catch (e) {
      // P1-3 fix (H-MEM-7): do NOT mark settings as loaded on error.
      // Previous code set `settingsLoaded = true` in the catch block — a
      // transient DB error would permanently lock the app to env defaults
      // with no retry. Now we leave settingsLoaded = false so the next
      // call to loadSettings() will retry.
      logger.warn('llm', 'Failed to load settings — keeping env defaults, will retry on next call', {
        baseUrl: currentBaseUrl,
        model: currentModel,
      }, e);
    } finally {
      settingsLoadPromise = null;
    }
  })();

  return settingsLoadPromise;
}

/**
 * Принудительно перечитать настройки из БД.
 * Полезно когда внешний процесс (или другой запрос) изменил настройки,
 * а текущий in-memory кэш устарел.
 */
export async function reloadSettings(): Promise<void> {
  settingsLoaded = false;
  settingsLoadedAt = 0;
  healthCache = null;
  await loadSettings();
}

/** Seed DB from .env on first run; otherwise mirror DB settings into process.env. */
export async function ensureOllamaEnvDbReconciled(): Promise<void> {
  await loadSettings();
  await reconcileOllamaEnvAndDb({
    baseUrl: currentBaseUrl,
    model: currentModel,
    agentModel: currentAgentModel,
    secondaryModel: currentSecondaryModel,
    heavyModel: currentHeavyModel,
    embedModel: currentEmbedModel,
  });
}

export async function getOllamaSettings() {
  await loadSettings();
  return {
    baseUrl: currentBaseUrl,
    model: currentModel,
    /** Configured agent model; empty string means “same as chat”. */
    agentModel: currentAgentModel,
    agentModelEffective: resolveAgentModelName(currentModel, currentAgentModel),
    /** Configured secondary; empty = unset. */
    secondaryModel: currentSecondaryModel,
    /** Configured heavy; empty = unset (escalate no-ops). */
    heavyModel: currentHeavyModel,
    /** Effective heavy: configured or agent/chat fallback. */
    heavyModelEffective: currentHeavyModel.trim()
      || resolveAgentModelName(currentModel, currentAgentModel),
    embedModel: currentEmbedModel || 'auto',
  };
}

export async function setOllamaSettings(params: {
  baseUrl?: string;
  model?: string;
  /** Empty string clears override (agent follows chat model). */
  agentModel?: string;
  /** Empty string clears secondary. */
  secondaryModel?: string;
  /** Empty string clears heavy (escalate no-ops). */
  heavyModel?: string;
  embedModel?: string;
}) {
  settingsLoaded = true;
  settingsLoadedAt = Date.now();

  if (params.baseUrl !== undefined) {
    const normalized = normalizeOllamaBaseUrl(params.baseUrl);
    currentBaseUrl = (normalized ?? params.baseUrl).replace(/\/$/, '');
    await db.setting.upsert({
      where: { key: 'ollama_base_url' },
      create: { key: 'ollama_base_url', value: currentBaseUrl },
      update: { value: currentBaseUrl },
    });
    provider = null;
    providerBaseUrl = '';
  }
  if (params.model !== undefined) {
    currentModel = params.model;
    await db.setting.upsert({
      where: { key: 'ollama_model' },
      create: { key: 'ollama_model', value: currentModel },
      update: { value: currentModel },
    });
  }
  if (params.agentModel !== undefined) {
    currentAgentModel = params.agentModel.trim();
    if (currentAgentModel === '') {
      await db.setting.deleteMany({ where: { key: 'ollama_agent_model' } });
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_agent_model' },
        create: { key: 'ollama_agent_model', value: currentAgentModel },
        update: { value: currentAgentModel },
      });
    }
  }
  if (params.secondaryModel !== undefined) {
    currentSecondaryModel = params.secondaryModel.trim();
    if (currentSecondaryModel === '') {
      await db.setting.deleteMany({ where: { key: 'ollama_secondary_model' } });
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_secondary_model' },
        create: { key: 'ollama_secondary_model', value: currentSecondaryModel },
        update: { value: currentSecondaryModel },
      });
    }
  }
  if (params.heavyModel !== undefined) {
    currentHeavyModel = params.heavyModel.trim();
    if (currentHeavyModel === '') {
      await db.setting.deleteMany({ where: { key: 'ollama_heavy_model' } });
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_heavy_model' },
        create: { key: 'ollama_heavy_model', value: currentHeavyModel },
        update: { value: currentHeavyModel },
      });
    }
  }
  if (params.embedModel !== undefined) {
    currentEmbedModel = params.embedModel;
    if (params.embedModel === '') {
      await db.setting.deleteMany({ where: { key: 'ollama_embed_model' } });
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_embed_model' },
        create: { key: 'ollama_embed_model', value: currentEmbedModel },
        update: { value: currentEmbedModel },
      });
    }
  }
  healthCache = null;
  mirrorOllamaToProcessEnv({
    baseUrl: currentBaseUrl,
    model: currentModel,
    agentModel: currentAgentModel,
    secondaryModel: currentSecondaryModel,
    heavyModel: currentHeavyModel,
    embedModel: currentEmbedModel,
  });
}

// ============================================================================
// AI SDK provider — Ollama (local)
// ============================================================================

let provider: ReturnType<typeof createOpenAICompatible> | null = null;
let providerBaseUrl = '';

async function getOllamaProvider() {
  await loadSettings();
  if (provider && providerBaseUrl === currentBaseUrl) return provider;
  provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${currentBaseUrl}/v1`,
    apiKey: 'ollama',
    fetch: async (input, init) => {
      if ((activeOllamaNumCtx || activeOllamaKeepAlive !== undefined) && init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          const prev = (body.options as Record<string, unknown> | undefined) ?? {};
          const nextOpts: Record<string, unknown> = { ...prev };
          if (activeOllamaNumCtx) nextOpts.num_ctx = activeOllamaNumCtx;
          body.options = nextOpts;
          if (activeOllamaKeepAlive !== undefined) {
            body.keep_alive = activeOllamaKeepAlive;
          }
          init = { ...init, body: JSON.stringify(body) };
        } catch {
          // leave body unchanged
        }
      }
      return fetch(input, init);
    },
  });
  providerBaseUrl = currentBaseUrl;
  return provider;
}

/** Invalidate cached provider so num_ctx fetch-wrapper is always attached after HMR. */
export function invalidateOllamaProvider(): void {
  provider = null;
  providerBaseUrl = '';
}

/**
 * Returns the model object for use with AI SDK's streamText/generateText.
 *
 * Uses the configured Ollama chat model (with health check + fallback).
 *
 * @param overrideModel Optional model name to use instead of the configured one.
 *   Used by auto model selection (chat/model-selection.ts) to swap in a smaller
 *   model for trivial queries. If the override model is not available, falls
 *   back to the configured model.
 */
export async function getChatModel(overrideModel?: string) {
  await loadSettings();

  const p = await getOllamaProvider();
  const health = await checkOllamaHealth();

  if (health.ok && health.models.length > 0) {
    // If override specified, only accept exact match (don't fuzzy-match).
    // The auto-selection code already verified the model is pulled.
    if (overrideModel) {
      if (health.models.includes(overrideModel)) {
        logger.debug('llm', `Using override model: ${overrideModel}`);
        return p.chatModel(overrideModel);
      }
      // Override requested but not available — fall through to normal logic.
      logger.warn('llm', `Override model not available, falling back to configured`, {
        override: overrideModel,
        configured: currentModel,
      });
    }

    const exactMatch = health.models.find(m => m === currentModel);
    if (exactMatch) {
      logger.debug('llm', `Using configured model: ${currentModel}`);
      return p.chatModel(currentModel);
    }
    const partialMatch = health.models.find(m =>
      m.startsWith(currentModel.split(':')[0]) ||
      m.startsWith(currentModel) ||
      currentModel.startsWith(m.split(':')[0])
    );
    if (partialMatch) {
      logger.warn('llm', `Model not found, using partial match`, {
        requested: currentModel,
        using: partialMatch,
      });
      return p.chatModel(partialMatch);
    }
    const fallback = health.models[0];
    // P3-8 fix: filter out known embed models from the fallback.
    // health.models[0] could be 'nomic-embed-text' (an embed model, not chat) —
    // using it as a chat fallback produces garbage responses.
    const EMBED_MODEL_PATTERNS = /embed|nomic|minilm|e5/i;
    const chatModels = health.models.filter(m => !EMBED_MODEL_PATTERNS.test(m));
    const safeFallback = chatModels[0] ?? fallback;
    logger.warn('llm', `Model not found, using first available chat model`, {
      requested: currentModel,
      using: safeFallback,
      allModels: health.models.slice(0, 5),
      skippedEmbedModels: health.models.filter(m => EMBED_MODEL_PATTERNS.test(m)),
    });
    return p.chatModel(safeFallback);
  }

  logger.warn('llm', `Health check failed — using configured model anyway (will likely 404)`, { model: currentModel });
  return p.chatModel(currentModel);
}

/**
 * Возвращает имя текущей модели (для логирования и NO_TOOL_MODELS check).
 */
export async function getModelName(): Promise<string> {
  await loadSettings();
  return currentModel;
}

/**
 * Effective model name for the agent runner (plan / execute / synthesize).
 * Falls back to the chat model when `ollama_agent_model` is unset.
 */
export async function getAgentModelName(): Promise<string> {
  await loadSettings();
  return resolveAgentModelName(currentModel, currentAgentModel);
}

/**
 * Configured heavy model name, or null when unset (escalate should no-op).
 * Does not fall back to agent/chat — use getHeavyModelNameEffective for that.
 */
export async function getHeavyModelName(): Promise<string | null> {
  await loadSettings();
  const h = currentHeavyModel.trim();
  return h || null;
}

/**
 * Heavy if configured; otherwise agent/chat fallback.
 * Empty heavy ⇒ same as agent (documented for escalate callers).
 */
export async function getHeavyModelNameEffective(): Promise<string> {
  await loadSettings();
  const h = currentHeavyModel.trim();
  if (h) return h;
  return resolveAgentModelName(currentModel, currentAgentModel);
}

/**
 * Model object for agent plan/execute/synthesize.
 * When an agent model is configured, uses that Ollama name; otherwise follows getChatModel().
 */
export async function getAgentModel() {
  await loadSettings();
  const configured = currentAgentModel.trim();
  if (!configured) {
    return getChatModel();
  }
  return getChatModel(configured);
}

/** Model object for heavy escalate; falls back to agent/chat when heavy unset. */
export async function getHeavyModel() {
  const name = await getHeavyModelNameEffective();
  return getChatModel(name);
}

// ============================================================================
// Embeddings — direct HTTP to Ollama
// ============================================================================
//
// Embed model is auto-detected from available models — user doesn't need to
// choose. We look for known embed model prefixes (nomic-embed, mxbai-embed,
// bge-m3, snowflake-arctic-embed). If none found, we try the configured one
// (default 'nomic-embed-text') and surface a clear error if it's missing.

const EMBED_MODEL_PREFIXES = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'snowflake-arctic-embed',
];

function pickEmbedModelFromList(available: string[]): string | null {
  for (const prefix of EMBED_MODEL_PREFIXES) {
    const match = available.find(m => m.startsWith(prefix));
    if (match) return match;
  }
  return null;
}

export async function embed(text: string): Promise<Float32Array> {
  // ── Embed cache (Sprint 8B-audit B6) ──
  // On a single chat message, embed() is called up to 3 times with the same
  // text: once by recall() in buildChatContext, once by recallEmotionalAnchors(),
  // and once by KB search (when shouldPreSearchKb is true). On 8B each embed
  // takes 1-3s — 3 calls = 3-9s of redundant latency on every non-trivial
  // message.
  //
  // This LRU cache deduplicates concurrent and sequential calls within a
  // short TTL. The cache key includes the embed model name so it auto-
  // invalidates when the user switches models. Size is bounded to 64 entries
  // to cap memory (~64 × 768 floats × 4 bytes = ~190KB max).
  //
  // In-flight deduplication: if two callers request the same text simultan-
  // eously, they share one Promise (request coalescing) — important because
  // recall() and recallEmotionalAnchors() fire in parallel via Promise.all.
  const cacheKey = `${currentEmbedModel}::${text.slice(0, 2000)}`;
  const now = Date.now();

  // Check completed cache (TTL hit)
  const cached = embedCache.get(cacheKey);
  if (cached) {
    if (now - cached.ts < EMBED_CACHE_TTL_MS) {
      return cached.value;
    }
    embedCache.delete(cacheKey);
  }

  // Check in-flight deduplication map
  const inflight = embedInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  // Start a new embed call
  const promise = embedUncached(text).then((value) => {
    embedCache.set(cacheKey, { value, ts: Date.now() });
    embedInflight.delete(cacheKey);
    // LRU eviction: if cache grew beyond max size, evict oldest entries.
    // Map preserves insertion order in JS, so the first entry is the oldest.
    if (embedCache.size > EMBED_CACHE_MAX_SIZE) {
      const oldestKey = embedCache.keys().next().value;
      if (oldestKey) embedCache.delete(oldestKey);
    }
    return value;
  }).catch((e) => {
    embedInflight.delete(cacheKey);
    throw e;
  });

  embedInflight.set(cacheKey, promise);
  return promise;
}

// ── Embed cache internals ──
const EMBED_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const EMBED_CACHE_MAX_SIZE = 64;
const embedCache = new Map<string, { value: Float32Array; ts: number }>();
const embedInflight = new Map<string, Promise<Float32Array>>();

/**
 * Uncached embed — the original implementation. Calls Ollama /api/embed
 * directly. Used by embed() above which adds caching/deduplication.
 *
 * Exported for advanced callers that explicitly want to bypass the cache
 * (e.g. KB indexer batching unique chunks — cache hit rate would be ~0%
 * and we'd waste memory on one-shot embeddings).
 */
export async function embedUncached(text: string): Promise<Float32Array> {
  await loadSettings();
  const embedStart = Date.now();

  // Auto-detect embed model if the current one isn't in the available list
  // OR if it's empty (user selected "auto" in UI)
  let modelToUse = currentEmbedModel;
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const exactMatch = health.models.find(m => m === currentEmbedModel);
    if (!exactMatch) {
      const detected = pickEmbedModelFromList(health.models);
      if (detected) {
        modelToUse = detected;
        // Persist the auto-detected choice so we don't re-detect every call
        if (detected !== currentEmbedModel) {
          logger.info('ollama', `Auto-detected embed model: ${detected}`);
          currentEmbedModel = detected;
          // Save to DB so we don't re-detect every call
          try {
            await db.setting.upsert({
              where: { key: 'ollama_embed_model' },
              create: { key: 'ollama_embed_model', value: detected },
              update: { value: detected },
            });
          } catch { /* non-fatal */ }
        }
      } else if (!currentEmbedModel) {
        // No embed model configured AND none detected — throw clear error
        logger.error('ollama', 'No embed model available — throwing clear error', {
          availableModels: health.models.slice(0, 5),
        });
        throw new Error(
          'Не настроена модель для памяти. Скачай nomic-embed-text: ollama pull nomic-embed-text, ' +
          'или выбери модель в Настройках → Модель → Модель для памяти.'
        );
      }
    }
  }

  if (!modelToUse) {
    throw new Error(
      'Модель для памяти не выбрана. Открой Настройки → Модель и выбери embed-модель (или режим Авто).'
    );
  }

  try {
    const res = await fetch(`${currentBaseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelToUse, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.error('ollama', `Embed HTTP error`, {
        status: res.status,
        model: modelToUse,
        textLength: text.length,
        responsePreview: t.slice(0, 200),
      });
      throw new Error(`Ollama embed HTTP ${res.status}: ${t}`);
    }
    const data = await res.json();
    const vec = data?.embeddings?.[0] ?? data?.embedding;
    if (!Array.isArray(vec)) {
      logger.error('ollama', 'Embed returned no vector', { model: modelToUse, responseKeys: Object.keys(data ?? {}) });
      throw new Error('Ollama embed returned no vector');
    }
    logger.debug('ollama', `Embed done (${Date.now() - embedStart}ms)`, {
      model: modelToUse,
      dims: vec.length,
      textLength: text.length,
    });
    return new Float32Array(vec);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Ollama embed HTTP')) throw e;
    // ECONNREFUSED — Ollama не запущен. Ожидаемо при первом запуске.
    // Логируем как warn без полного stack trace, чтобы не засорять логи.
    const isConnRefused = e instanceof Error && (e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed'));
    if (isConnRefused) {
      logger.warn('ollama', 'Embed skipped — Ollama not reachable', {
        model: modelToUse,
        baseUrl: currentBaseUrl,
      });
    } else {
      logger.error('ollama', 'Embed fetch failed', { model: modelToUse }, e);
    }
    throw e;
  }
}

/**
 * Resolve the embed model to use, with auto-detection and persistence.
 * Extracted from embedUncached() so embedBatchUncached() can reuse it
 * without duplicating the auto-detection logic.
 *
 * Returns null if no embed model is available — caller should throw a
 * clear error to the user.
 */
async function resolveEmbedModel(): Promise<string | null> {
  await loadSettings();
  let modelToUse = currentEmbedModel;
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const exactMatch = health.models.find(m => m === currentEmbedModel);
    if (!exactMatch) {
      const detected = pickEmbedModelFromList(health.models);
      if (detected) {
        modelToUse = detected;
        if (detected !== currentEmbedModel) {
          logger.info('ollama', `Auto-detected embed model: ${detected}`);
          currentEmbedModel = detected;
          try {
            await db.setting.upsert({
              where: { key: 'ollama_embed_model' },
              create: { key: 'ollama_embed_model', value: detected },
              update: { value: detected },
            });
          } catch { /* non-fatal */ }
        }
      } else if (!currentEmbedModel) {
        logger.error('ollama', 'No embed model available — throwing clear error', {
          availableModels: health.models.slice(0, 5),
        });
        return null;
      }
    }
  }
  return modelToUse || null;
}

/**
 * Batch embed — embed multiple texts in a single Ollama /api/embed call.
 *
 * Ollama's /api/embed endpoint accepts `input: [t1, t2, ...]` and returns
 * `embeddings: [[...], [...], ...]` — one vector per input. This is 4-8x
 * faster than N separate HTTP calls because:
 *   - One HTTP round-trip instead of N
 *   - Ollama batches the inference internally (GPU processes all texts
 *     in one forward pass when they fit in a batch)
 *   - No per-call model warmup overhead
 *
 * Used by KB indexer for bulk chunk embedding. Not cached — chunks are
 * unique, cache hit rate would be ~0%.
 *
 * @param texts array of texts to embed (max 64 per call — larger arrays
 *   are chunked into batches of 64 internally to avoid OOM on small GPUs)
 * @returns array of the same length; null for texts that failed to embed
 *   (individual failures don't fail the whole batch)
 */
export async function embedBatchUncached(texts: string[]): Promise<Array<Float32Array | null>> {
  if (texts.length === 0) return [];

  const modelToUse = await resolveEmbedModel();
  if (!modelToUse) {
    throw new Error(
      'Модель для памяти не выбрана. Открой Настройки → Модель и выбери embed-модель (или режим Авто).'
    );
  }

  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  const BATCH_SIZE = 64;  // Ollama handles up to 64 in one call comfortably

  for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, texts.length);
    const batch = texts.slice(batchStart, batchEnd);
    const batchStartMs = Date.now();

    try {
      const res = await fetch(`${currentBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToUse, input: batch }),
        signal: AbortSignal.timeout(120_000),  // 2 min — batch can take a while
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        logger.error('ollama', `Embed batch HTTP error`, {
          status: res.status,
          model: modelToUse,
          batchSize: batch.length,
          responsePreview: t.slice(0, 200),
        });
        // Leave nulls for this batch — caller decides how to handle
        continue;
      }
      const data = await res.json();
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings)) {
        logger.error('ollama', 'Embed batch returned no embeddings array', {
          model: modelToUse,
          responseKeys: Object.keys(data ?? {}),
        });
        continue;
      }
      embeddings.forEach((vec, idx) => {
        if (Array.isArray(vec) && batchStart + idx < results.length) {
          results[batchStart + idx] = new Float32Array(vec);
        }
      });
      logger.debug('ollama', `Embed batch done (${Date.now() - batchStartMs}ms)`, {
        model: modelToUse,
        batchSize: batch.length,
        dims: embeddings[0]?.length ?? 0,
      });
    } catch (e) {
      const isConnRefused = e instanceof Error && (e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed'));
      if (isConnRefused) {
        logger.warn('ollama', 'Embed batch skipped — Ollama not reachable', {
          model: modelToUse,
          batchSize: batch.length,
        });
      } else {
        logger.error('ollama', 'Embed batch failed (non-fatal, batch skipped)', {
          model: modelToUse,
          batchSize: batch.length,
        }, e);
      }
      // Leave nulls for this batch
    }
  }

  return results;
}

// ============================================================================
// Health check
// ============================================================================
let healthCache: { ok: boolean; models: string[]; error?: string; ts: number } | null = null;
const HEALTH_TTL = 30_000;

export async function checkOllamaHealth(options?: { timeoutMs?: number }): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  // Always prefer warm cache — timeoutMs only applies on cache miss (dedupe preflight).
  if (healthCache && Date.now() - healthCache.ts < HEALTH_TTL) {
    return healthCache;
  }
  await loadSettings();
  try {
    const res = await fetch(`${currentBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const result = { ok: false, models: [] as string[], error: `HTTP ${res.status}` };
      healthCache = { ...result, ts: Date.now() };
      return result;
    }
    const data = await res.json();
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    const result = { ok: true as const, models, error: undefined };
    healthCache = { ...result, ts: Date.now() };
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const result = { ok: false, models: [] as string[], error: msg };
    healthCache = { ...result, ts: Date.now() };
    return result;
  }
}

// ============================================================================
// LLM preflight — shared by chat pipeline and agent runner
// ============================================================================

type LlmPreflightFailure = {
  code: 'ollama_down' | 'ollama_no_models';
  message: string;
  details?: string;
  ollamaUrl?: string;
};

export async function checkLlmPreflight(): Promise<
  | { ok: true; provider: 'ollama'; ollama: Awaited<ReturnType<typeof checkOllamaHealth>> }
  | { ok: false; failure: LlmPreflightFailure }
> {
  await loadSettings();
  let ollama = await checkOllamaHealth();

  if (!ollama.ok) {
    const isTimeout = ollama.error?.includes('timeout') || ollama.error?.includes('aborted');
    if (isTimeout) {
      await new Promise(r => setTimeout(r, 1500));
      ollama = await checkOllamaHealth({ timeoutMs: 20_000 });
    }
  }

  if (!ollama.ok) {
    return {
      ok: false,
      failure: {
        code: 'ollama_down',
        message: 'Ollama недоступен. Запусти `ollama serve` или проверь URL в настройках.',
        details: ollama.error,
        ollamaUrl: currentBaseUrl,
      },
    };
  }

  if (ollama.models.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'ollama_no_models',
        message: 'В Ollama нет моделей. Скачай хотя бы одну: `ollama pull qwen3:8b`.',
      },
    };
  }

  return { ok: true, provider: 'ollama', ollama };
}
