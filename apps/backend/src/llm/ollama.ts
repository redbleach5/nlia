/**
 * Ollama integration — local LLM provider.
 *
 * Ported from v2 src/lib/ollama.ts with simplifications:
 *   - Drizzle instead of Prisma (sync API, no codegen)
 *   - No secondary model (v3 consolidates to 4 slots: chat/agent/heavy/embed)
 *   - No env→DB reconciliation (v3: DB is the single source of truth)
 *
 * Architecture (per docs/ARCHITECTURE.md § 3.2.5):
 *   - Vercel AI SDK v7 `@ai-sdk/openai-compatible` for streamText / generateText
 *   - Native fetch for /api/tags (health) and /api/embed (embeddings)
 *   - Settings persisted in `settings` table; cached in-memory with 1s TTL
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { settings as settingsTable } from "../db/schema.js";
import { logger } from "../util/logger.js";
import { env } from "../util/env.js";

// ─── Defaults (used when settings table is empty) ─────────────────────
const DEFAULT_BASE_URL = env.ollamaHost;
const DEFAULT_CHAT_MODEL = "qwen3:8b";
const DEFAULT_AGENT_MODEL = ""; // empty = same as chat
const DEFAULT_HEAVY_MODEL = ""; // empty = no escalate
const DEFAULT_EMBED_MODEL = "nomic-embed-text";

// ─── In-memory cached settings (1s TTL for cross-request freshness) ───
interface OllamaSettings {
  baseUrl: string;
  chat: string;
  agent: string;
  heavy: string;
  embed: string;
}

let current: OllamaSettings = {
  baseUrl: DEFAULT_BASE_URL,
  chat: DEFAULT_CHAT_MODEL,
  agent: DEFAULT_AGENT_MODEL,
  heavy: DEFAULT_HEAVY_MODEL,
  embed: DEFAULT_EMBED_MODEL,
};
let settingsLoaded = false;
let settingsLoadedAt = 0;
const SETTINGS_CACHE_TTL_MS = 1_000;
let settingsLoadPromise: Promise<void> | null = null;

// ─── Health cache (30s TTL) ───────────────────────────────────────────
interface OllamaHealth {
  ok: boolean;
  models: string[];
  error?: string;
  ts: number;
}
let healthCache: OllamaHealth | null = null;
const HEALTH_TTL_MS = 30_000;

// ─── AI SDK provider (recreated only when baseUrl changes) ────────────
let provider: ReturnType<typeof createOpenAICompatible> | null = null;
let providerBaseUrl = "";

// ─── Settings persistence ─────────────────────────────────────────────
async function loadSettings(): Promise<void> {
  if (settingsLoaded && Date.now() - settingsLoadedAt < SETTINGS_CACHE_TTL_MS) {
    return;
  }
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    try {
      const sqlite = getDb();
      const db = drizzle(sqlite);
      const rows = await db.select().from(settingsTable).all();

      const next: OllamaSettings = {
        baseUrl: DEFAULT_BASE_URL,
        chat: DEFAULT_CHAT_MODEL,
        agent: DEFAULT_AGENT_MODEL,
        heavy: DEFAULT_HEAVY_MODEL,
        embed: DEFAULT_EMBED_MODEL,
      };
      for (const row of rows) {
        switch (row.key) {
          case "ollama_base_url":
            if (row.value) next.baseUrl = row.value;
            break;
          case "ollama_model":
            if (row.value) next.chat = row.value;
            break;
          case "ollama_agent_model":
            next.agent = row.value;
            break;
          case "ollama_heavy_model":
            next.heavy = row.value;
            break;
          case "ollama_embed_model":
            // Empty value means "auto" — fall back to default
            next.embed = row.value || DEFAULT_EMBED_MODEL;
            break;
        }
      }

      const changed = JSON.stringify(next) !== JSON.stringify(current);
      current = next;
      settingsLoaded = true;
      settingsLoadedAt = Date.now();
      if (changed) {
        logger.debug({ settings: next }, "ollama settings loaded from DB");
      }
    } catch (e) {
      // Do NOT mark as loaded — retry on next call (v2 P1-3 fix)
      logger.warn({ err: e }, "failed to load ollama settings — keeping defaults");
    } finally {
      settingsLoadPromise = null;
    }
  })();

  return settingsLoadPromise;
}

/** Force-reload settings from DB (used by setOllamaSettings + tests). */
export async function reloadSettings(): Promise<void> {
  settingsLoaded = false;
  settingsLoadedAt = 0;
  healthCache = null;
  await loadSettings();
}

export async function getOllamaSettings(): Promise<OllamaSettings> {
  await loadSettings();
  return { ...current };
}

/**
 * Update Ollama settings. Each field is optional — only provided fields are
 * mutated. Empty string clears the slot (for agent/heavy/embed).
 */
export async function setOllamaSettings(patch: Partial<OllamaSettings>): Promise<void> {
  await loadSettings();
  const sqlite = getDb();
  const db = drizzle(sqlite);

  const upsert = (key: string, value: string) => {
    const existing = db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, key))
      .get();
    const now = Math.floor(Date.now() / 1000);
    if (existing) {
      db.update(settingsTable)
        .set({ value, updatedAt: now })
        .where(eq(settingsTable.key, key))
        .run();
    } else {
      db.insert(settingsTable)
        .values({ key, value, updatedAt: now })
        .run();
    }
  };
  const remove = (key: string) => {
    db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
  };

  if (patch.baseUrl !== undefined) {
    current.baseUrl = patch.baseUrl;
    upsert("ollama_base_url", patch.baseUrl);
  }
  if (patch.chat !== undefined) {
    current.chat = patch.chat;
    upsert("ollama_model", patch.chat);
  }
  if (patch.agent !== undefined) {
    current.agent = patch.agent;
    if (patch.agent === "") remove("ollama_agent_model");
    else upsert("ollama_agent_model", patch.agent);
  }
  if (patch.heavy !== undefined) {
    current.heavy = patch.heavy;
    if (patch.heavy === "") remove("ollama_heavy_model");
    else upsert("ollama_heavy_model", patch.heavy);
  }
  if (patch.embed !== undefined) {
    current.embed = patch.embed || DEFAULT_EMBED_MODEL;
    if (patch.embed === "") remove("ollama_embed_model");
    else upsert("ollama_embed_model", patch.embed);
  }

  healthCache = null;
  settingsLoaded = true;
  settingsLoadedAt = Date.now();
}

// ─── AI SDK provider ──────────────────────────────────────────────────
async function getProvider(): Promise<ReturnType<typeof createOpenAICompatible>> {
  await loadSettings();
  if (provider && providerBaseUrl === current.baseUrl) return provider;
  provider = createOpenAICompatible({
    name: "ollama",
    baseURL: `${current.baseUrl}/v1`,
    apiKey: "ollama", // Ollama ignores the key but the SDK requires one
  });
  providerBaseUrl = current.baseUrl;
  return provider;
}

// ─── Health check ─────────────────────────────────────────────────────
export async function checkOllamaHealth(opts?: { timeoutMs?: number; force?: boolean }): Promise<OllamaHealth> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  if (!opts?.force && healthCache && Date.now() - healthCache.ts < HEALTH_TTL_MS) {
    return healthCache;
  }
  await loadSettings();
  try {
    const res = await fetch(`${current.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const result: OllamaHealth = {
        ok: false,
        models: [],
        error: `HTTP ${res.status}`,
        ts: Date.now(),
      };
      healthCache = result;
      return result;
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    const result: OllamaHealth = { ok: true, models, ts: Date.now() };
    healthCache = result;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const result: OllamaHealth = { ok: false, models: [], error: msg, ts: Date.now() };
    healthCache = result;
    return result;
  }
}

// ─── Model resolution (with health-check fallback) ────────────────────
const EMBED_MODEL_PATTERNS = /embed|nomic|minilm|e5/i;

export type ModelRole = "chat" | "agent" | "heavy" | "embed";

export function isEmbedModelName(name: string): boolean {
  return EMBED_MODEL_PATTERNS.test(name);
}

/** Normalize tag so `foo` and `foo:latest` compare equal. */
function normalizeModelTag(name: string): string {
  const trimmed = name.trim();
  if (trimmed.endsWith(":latest")) return trimmed.slice(0, -":latest".length);
  return trimmed;
}

function modelsEqual(a: string, b: string): boolean {
  return normalizeModelTag(a) === normalizeModelTag(b);
}

function filterByRole(available: string[], role: ModelRole): string[] {
  if (role === "embed") return available.filter((m) => isEmbedModelName(m));
  return available.filter((m) => !isEmbedModelName(m));
}

function resolveAgentName(chat: string, agent: string): string {
  return agent.trim() || chat;
}

export interface ResolveModelResult {
  resolved: string;
  fallback: boolean;
  matched: "exact" | "tag" | "partial" | "fallback" | "none";
}

/**
 * Resolve a requested model name against the actually-pulled models.
 * Role filters candidates so chat never picks an embed model via partial match.
 */
export function resolveModelName(
  requested: string,
  available: string[],
  role: ModelRole = "chat",
): ResolveModelResult {
  if (!requested.trim()) {
    return { resolved: requested, fallback: false, matched: "none" };
  }
  if (available.length === 0) {
    return { resolved: requested, fallback: false, matched: "none" };
  }

  const pool = filterByRole(available, role);
  const searchIn = pool.length > 0 ? pool : available;

  const exact = searchIn.find((m) => m === requested);
  if (exact) return { resolved: exact, fallback: false, matched: "exact" };

  const tagMatch = searchIn.find((m) => modelsEqual(m, requested));
  if (tagMatch) return { resolved: tagMatch, fallback: false, matched: "tag" };

  const family = requested.split(":")[0] ?? requested;
  const partial = searchIn.find(
    (m) =>
      m.startsWith(family) ||
      m.startsWith(requested) ||
      requested.startsWith(m.split(":")[0] ?? m),
  );
  if (partial) {
    logger.warn({ requested, using: partial, role }, "model not found exactly, using partial match");
    return { resolved: partial, fallback: false, matched: "partial" };
  }

  if (role !== "embed" && pool.length > 0) {
    logger.warn(
      { requested, using: pool[0], role, allModels: available.slice(0, 5) },
      "model not found, using first available chat model",
    );
    return { resolved: pool[0]!, fallback: true, matched: "fallback" };
  }

  if (role === "embed" && pool.length > 0) {
    logger.warn(
      { requested, using: pool[0], role },
      "embed model not found, using first available embed model",
    );
    return { resolved: pool[0]!, fallback: true, matched: "fallback" };
  }

  return { resolved: requested, fallback: false, matched: "none" };
}

/**
 * Get the LanguageModel for chat. Performs a health check (cached) and
 * resolves the configured chat model name against available models.
 */
export async function getChatModel(): Promise<ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>> {
  await loadSettings();
  const p = await getProvider();
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const { resolved } = resolveModelName(current.chat, health.models, "chat");
    return p.chatModel(resolved);
  }
  logger.warn({ model: current.chat }, "ollama health check failed — using configured model anyway");
  return p.chatModel(current.chat);
}

/** Effective resolved chat model name (for /api/show, budgets, etc.). */
export async function resolveChatModelName(): Promise<string> {
  await loadSettings();
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    return resolveModelName(current.chat, health.models, "chat").resolved;
  }
  return current.chat;
}

/** Effective agent model name (agent slot, or chat if agent is empty). */
export async function getAgentModelName(): Promise<string> {
  await loadSettings();
  return resolveAgentName(current.chat, current.agent);
}

/** Configured heavy model name, or null if unset (escalate should no-op). */
export async function getHeavyModelName(): Promise<string | null> {
  await loadSettings();
  const h = current.heavy.trim();
  return h || null;
}

/**
 * Get the LanguageModel for agent tasks. Resolves agent slot, falls back to
 * chat. Performs health check + model resolution.
 */
export async function getAgentModel(): Promise<ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>> {
  await loadSettings();
  const p = await getProvider();
  const health = await checkOllamaHealth();
  const name = resolveAgentName(current.chat, current.agent);
  if (health.ok && health.models.length > 0) {
    return p.chatModel(resolveModelName(name, health.models, "agent").resolved);
  }
  return p.chatModel(name);
}

// ─── Embeddings ───────────────────────────────────────────────────────
/**
 * Embed a batch of texts via Ollama /api/embed.
 * Returns Float32Array per input; null for individual failures (non-fatal).
 *
 * Batches of 64 internally to avoid OOM on small GPUs.
 */
export async function embedBatchUncached(texts: string[]): Promise<Array<Float32Array | null>> {
  if (texts.length === 0) return [];
  await loadSettings();

  const health = await checkOllamaHealth();
  const configured = await resolveEmbedModel();
  const model =
    health.ok && health.models.length > 0
      ? resolveModelName(configured, health.models, "embed").resolved
      : configured;

  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  const BATCH_SIZE = 64;

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, texts.length);
    const batch = texts.slice(start, end);
    try {
      const res = await fetch(`${current.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        logger.error(
          { status: res.status, model, batchSize: batch.length, preview: t.slice(0, 200) },
          "embed batch HTTP error",
        );
        continue;
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(data.embeddings)) {
        logger.error({ model, keys: Object.keys(data ?? {}) }, "embed batch: no embeddings array");
        continue;
      }
      data.embeddings.forEach((vec, idx) => {
        if (Array.isArray(vec) && start + idx < results.length) {
          results[start + idx] = new Float32Array(vec);
        }
      });
    } catch (e) {
      const isConnRefused =
        e instanceof Error &&
        (e.message.includes("ECONNREFUSED") || e.message.includes("fetch failed"));
      if (isConnRefused) {
        logger.warn({ model, batchSize: batch.length }, "embed batch skipped — ollama not reachable");
      } else {
        logger.error({ model, batchSize: batch.length, err: e }, "embed batch failed (non-fatal)");
      }
    }
  }
  return results;
}

/** Embed a single text. Convenience wrapper around embedBatchUncached. */
export async function embedText(text: string): Promise<Float32Array | null> {
  const [vec] = await embedBatchUncached([text]);
  return vec;
}

/**
 * Effective embed model name. Returns the configured name or, if empty,
 * the first embed-pattern model found in /api/tags, or the default.
 */
export async function resolveEmbedModel(): Promise<string> {
  await loadSettings();
  if (current.embed && current.embed !== DEFAULT_EMBED_MODEL) return current.embed;
  // Auto: probe Ollama for an embed-pattern model
  const health = await checkOllamaHealth();
  if (health.ok) {
    const found = health.models.find((m) => isEmbedModelName(m));
    if (found) return found;
  }
  return DEFAULT_EMBED_MODEL;
}

// ─── Capability profile (single payload for GET /api/capability) ──────
export async function getCapabilityProfile() {
  const [settings, health] = await Promise.all([
    getOllamaSettings(),
    checkOllamaHealth(),
  ]);

  const chatModels = health.ok ? filterByRole(health.models, "chat") : [];
  const embedModels = health.ok ? filterByRole(health.models, "embed") : [];

  // Resolve chat once; empty agent/heavy inherit without re-resolving
  let effectiveChat = settings.chat;
  let chatFallback = false;
  if (health.ok && health.models.length > 0) {
    const chatResult = resolveModelName(settings.chat, health.models, "chat");
    effectiveChat = chatResult.resolved;
    chatFallback = chatResult.fallback;
  }

  const agentConfigured = settings.agent.trim();
  const effectiveAgent =
    health.ok && health.models.length > 0 && agentConfigured
      ? resolveModelName(agentConfigured, health.models, "agent").resolved
      : agentConfigured
        ? agentConfigured
        : effectiveChat;

  const heavyConfigured = settings.heavy.trim();
  const effectiveHeavy =
    health.ok && health.models.length > 0 && heavyConfigured
      ? resolveModelName(heavyConfigured, health.models, "heavy").resolved
      : heavyConfigured
        ? heavyConfigured
        : effectiveChat;

  // embedExplicit: true when the user has explicitly chosen an embed model
  // (even if it happens to match the default). We detect this by checking if
  // the ollama_embed_model key exists in settings — if not, embed is "auto".
  const sqlite = getDb();
  const embedRow = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'ollama_embed_model'")
    .get() as { value: string } | undefined;
  const embedExplicit = !!embedRow;
  let effectiveEmbed = embedExplicit ? settings.embed : await resolveEmbedModel();
  if (health.ok && health.models.length > 0) {
    effectiveEmbed = resolveModelName(effectiveEmbed, health.models, "embed").resolved;
  }

  return {
    ollamaOk: health.ok,
    error: health.error,
    models: health.models,
    chatModels,
    embedModels,
    effective: {
      chat: effectiveChat,
      agent: effectiveAgent,
      heavy: effectiveHeavy,
      embed: effectiveEmbed,
    },
    embedExplicit,
    chatFallback: chatFallback || undefined,
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────
export function _resetForTests(): void {
  settingsLoaded = false;
  settingsLoadedAt = 0;
  healthCache = null;
  provider = null;
  providerBaseUrl = "";
  current = {
    baseUrl: DEFAULT_BASE_URL,
    chat: DEFAULT_CHAT_MODEL,
    agent: DEFAULT_AGENT_MODEL,
    heavy: DEFAULT_HEAVY_MODEL,
    embed: DEFAULT_EMBED_MODEL,
  };
}
