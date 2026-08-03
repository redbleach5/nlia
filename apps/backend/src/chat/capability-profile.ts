/**
 * Capability profile — tier-based model capabilities.
 *
 * Per docs/ARCHITECTURE.md § 2.5 (dynamic cognitive budget) + § 2.6 (long context).
 * Refactored from v2: NO hardcoded caps (TIER_INFERENCE_CTX_CAP removed).
 *
 * Tier is derived from the configured chat model's parameter count:
 *   micro: ≤4B params
 *   standard: 4B–14B
 *   plus: 14B–32B
 *   max: 32B+
 *
 * Context window comes from Ollama /api/show, NOT hardcoded.
 */

import { checkOllamaHealth, getOllamaSettings, resolveChatModelName } from "../llm/ollama.js";

export type ModelTier = "micro" | "standard" | "plus" | "max";

export interface CapabilityProfile {
  tier: ModelTier;
  /** Actual context window from Ollama /api/show (not capped) */
  modelContextWindow: number;
  /** Available VRAM-based pool cap */
  poolCapFromVRAM: number | null;
  /** Effective context window = min(modelContextWindow, poolCapFromVRAM) */
  effectiveContextWindow: number;
  /** Whether tools are enabled (always true on standard+ per principle 7) */
  toolsEnabled: boolean;
  /** Whether inner monologue should run (plus/max only) */
  innerMonologueEnabled: boolean;
  /** Max tokens for response (function of context, not hardcoded) */
  maxOutputTokens: number;
}

interface ShowCacheEntry {
  contextWindow: number;
  ts: number;
}

const SHOW_CACHE_TTL_MS = 120_000;
const showCache = new Map<string, ShowCacheEntry>();

/**
 * Detect model tier from model name.
 * Param-count tokens win over family names (gemma2:9b → standard, not micro).
 */
export function detectTier(modelName: string): ModelTier {
  const lower = modelName.toLowerCase();

  // Size indicators first (most specific)
  if (/\b(70b|72b|104b|120b|405b)\b/.test(lower)) return "max";
  if (/\b(32b|34b|qwen2\.5-32)\b/.test(lower)) return "plus";
  if (/\b(7b|8b|9b|11b|12b|13b|14b)\b/.test(lower)) return "standard";
  if (/\b(0\.5b|1b|1\.5b|2b|3b|4b)\b/.test(lower)) return "micro";

  // Family heuristics when size is absent
  if (/\b(phi|tiny|gemma-?2?)\b/.test(lower) && !/\b(7b|8b|9b|27b)\b/.test(lower)) {
    // bare "gemma" / "gemma4" without size → micro only for tiny variants
    if (/\bgemma4?\b/.test(lower)) return "standard"; // gemma4:latest etc. are typically 4B+ usable as chat
    return "micro";
  }
  if (/\b(qwen2\.5|llama3|mistral|command-r)\b/.test(lower)) return "standard";

  // Default: standard (most common local companion size)
  return "standard";
}

/**
 * Get the capability profile for the current chat model.
 *
 * Per principle 6: NO TIER_INFERENCE_CTX_CAP. Context window comes from Ollama.
 * Per principle 5: NO cognitive-depth matrix. Tier only affects:
 *   - toolsEnabled (always true on standard+, gated on micro for trivial)
 *   - innerMonologueEnabled (plus/max only)
 *   - maxOutputTokens (function of context, not hardcoded)
 */
export async function getCapabilityProfile(): Promise<CapabilityProfile> {
  const settings = await getOllamaSettings();
  const health = await checkOllamaHealth();
  const chatModel = await resolveChatModelName();

  const tier = detectTier(chatModel);

  // Try to get model context window from Ollama /api/show (cached)
  let modelContextWindow = 8192; // fallback
  const cached = showCache.get(chatModel);
  if (cached && Date.now() - cached.ts < SHOW_CACHE_TTL_MS) {
    modelContextWindow = cached.contextWindow;
  } else {
    try {
      if (health.ok) {
        const res = await fetch(`${settings.baseUrl}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: chatModel }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            model_info?: { "llama.context_length"?: number };
            parameters?: string;
          };
          const ctxLen = data.model_info?.["llama.context_length"];
          if (ctxLen) modelContextWindow = ctxLen;
          if (data.parameters) {
            const match = data.parameters.match(/num_ctx\s+(\d+)/);
            if (match) modelContextWindow = parseInt(match[1]!, 10);
          }
          showCache.set(chatModel, { contextWindow: modelContextWindow, ts: Date.now() });
        }
      }
    } catch {
      // fallback to default
    }
  }

  // poolCapFromVRAM: M5.5 will query VRAM from capability API
  // For now: null (no cap, use modelContextWindow as-is)
  const poolCapFromVRAM = null;

  const effectiveContextWindow = poolCapFromVRAM
    ? Math.min(modelContextWindow, poolCapFromVRAM)
    : modelContextWindow;

  // maxOutputTokens: 25% of context window, capped at 8192
  // (not hardcoded 4096/8192 like v2 — function of context)
  const maxOutputTokens = Math.min(Math.floor(effectiveContextWindow * 0.25), 8192);

  return {
    tier,
    modelContextWindow,
    poolCapFromVRAM,
    effectiveContextWindow,
    toolsEnabled: tier !== "micro", // micro: gated per principle 7
    innerMonologueEnabled: tier === "plus" || tier === "max",
    maxOutputTokens,
  };
}

/** Test helper — clear /api/show cache. */
export function _resetShowCacheForTests(): void {
  showCache.clear();
}
