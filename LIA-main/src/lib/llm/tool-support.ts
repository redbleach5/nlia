import 'server-only';

// ============================================================================
// Tool calling support detection — определяет может ли модель вызывать tools.
// ============================================================================
//
// Раньше в pipeline.ts был захардкожен список NO_TOOL_MODELS. Проблема:
// новые модели не попадают в список автоматически → пытаются вызывать tools
// и падают.
//
// Стратегия:
//   1. Ollama /api/show → capabilities (если есть) — source of truth
//   2. Известные модели без tools (gemma, phi, dolphin на Ollama, …)
//   3. Семейства с tools (qwen2.5+, llama-3.1+, …) — whitelist
//   4. Неизвестные — conservative true (пробуем tools)
//
// Ошибка вида «does not support tools» в чате = мы отправили tools модели,
// у которой Ollama/провайдер их не объявил. Heuristic + /api/show это чинят.

import { logger } from '@/lib/logger';

// Известные модели без tool calling support. Pattern matching по имени
// (в т.ч. namespaced `org/model:tag`).
const NO_TOOL_PATTERNS = [
  /^gemma[2-4]?:/i,         // gemma2-9b-it, gemma3:4b, gemma4:latest
  /^gemma[2-4]-/i,          // gemma2-9b-it (hyphenated names)
  /(?:^|\/)gemma[2-4](?:[:/-]|$)/i,
  /^phi[2-4]?:/i,           // phi3, phi4
  /(?:^|\/)phi[2-4](?:[:/-]|$)/i,
  /^tinyllama:/i,
  /^llama-3\.2-[13]b-preview:/i,  // preview versions without tools
  // Broken / no-tools Dolphin packaging on Ollama (not all Dolphin — dolphin3 is OK).
  /dolphin-mistral-nemo/i,
];

// Семейства с tool calling support. Если модель попадает в любой из этих
// паттернов — tools поддерживаются (если не попала в NO_TOOL выше).
const TOOL_CAPABLE_PATTERNS = [
  /^qwen[2-9]/i,            // qwen2.5, qwen3 — все поддерживают tools
  /(?:^|\/)qwen[2-9]/i,
  /^llama-3\.[13]/i,        // llama-3.1, llama-3.3 (не preview)
  /^llama-3\.1-/i,
  /^llama-3\.3-/i,
  /^mixtral:/i,
  /^mistral:/i,
  /^mistral-/i,             // mistral-nemo, mistral-small (не dolphin-*)
  /^command-r/i,
  /^nemotron/i,
  /^deepseek/i,
  /^codellama/i,
  /^codestral/i,
  /^hermes/i,
  /^nexus/i,
  /^functionary/i,
  /^gorilla/i,
  /^nous-hermes/i,
];

/** Strip registry host / digest noise for matching. */
function normalizeModelName(modelName: string): string {
  return modelName
    .toLowerCase()
    .trim()
    // registry.ollama.ai/org/model:tag → org/model:tag
    .replace(/^registry\.ollama\.ai\//, '');
}

/**
 * Sync heuristic — whitelist / blacklist by model name.
 *
 * Prefer `resolveModelToolsSupport` in chat/agent paths (asks Ollama when possible).
 */
export function modelSupportsTools(modelName: string): boolean {
  if (!modelName) return false;

  const normalized = normalizeModelName(modelName);

  // Blacklist first — dolphin/gemma must win over broad mistral-* whitelist.
  if (NO_TOOL_PATTERNS.some(p => p.test(normalized))) {
    return false;
  }

  if (TOOL_CAPABLE_PATTERNS.some(p => p.test(normalized))) {
    return true;
  }

  // Conservative default для неизвестных моделей: пробуем tools.
  return true;
}

type CapsCacheEntry = { supports: boolean | null; ts: number };
const capsCache = new Map<string, CapsCacheEntry>();
const CAPS_TTL_MS = 60_000;

/**
 * Ask Ollama whether the model advertises tool calling.
 *
 * Returns:
 *   true/false — Ollama reported capabilities
 *   null — unknown (old Ollama, network error, non-Ollama provider)
 */
export async function fetchOllamaToolsCapability(
  modelName: string,
  baseUrl: string,
): Promise<boolean | null> {
  const key = `${baseUrl}::${normalizeModelName(modelName)}`;
  const cached = capsCache.get(key);
  if (cached && Date.now() - cached.ts < CAPS_TTL_MS) {
    return cached.supports;
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      capsCache.set(key, { supports: null, ts: Date.now() });
      return null;
    }
    const data = await res.json() as { capabilities?: unknown };
    if (!Array.isArray(data.capabilities)) {
      capsCache.set(key, { supports: null, ts: Date.now() });
      return null;
    }
    const supports = data.capabilities.map(String).includes('tools');
    capsCache.set(key, { supports, ts: Date.now() });
    return supports;
  } catch (e) {
    logger.warn('llm', 'Ollama /api/show capabilities probe failed', {
      model: modelName,
    }, e);
    capsCache.set(key, { supports: null, ts: Date.now() });
    return null;
  }
}

/**
 * Resolve tool support for the active chat/agent model.
 *
 * Ollama capabilities win when present; otherwise fall back to name heuristics.
 */
export async function resolveModelToolsSupport(modelName: string): Promise<boolean> {
  if (!modelName) return false;

  // Fast path: known no-tool families (dolphin etc.) — skip the network probe.
  const heuristic = modelSupportsTools(modelName);
  if (!heuristic && NO_TOOL_PATTERNS.some(p => p.test(normalizeModelName(modelName)))) {
    return false;
  }

  try {
    const { getOllamaSettings } = await import('@/lib/ollama');
    const settings = await getOllamaSettings();
    const fromOllama = await fetchOllamaToolsCapability(modelName, settings.baseUrl);
    if (fromOllama !== null) return fromOllama;
  } catch {
    // ignore — heuristic below
  }

  return heuristic;
}

/** @internal test helper */
export function _resetToolsCapabilityCache(): void {
  capsCache.clear();
}
