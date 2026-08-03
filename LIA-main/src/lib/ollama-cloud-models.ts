/**
 * Ollama cloud model catalog (ollama.com) for Settings pickers.
 */

import { logger } from '@/lib/logger';
import { isCloudModelTag, toCloudModelTag } from '@/lib/ollama-cloud-tags';

export { isCloudModelTag, toCloudModelTag } from '@/lib/ollama-cloud-tags';

const CLOUD_TAGS_URL = 'https://ollama.com/api/tags';
const CACHE_MS = 60 * 60 * 1000; // 1h

/** Curated coding-oriented cloud tags (fallback if catalog fetch fails). */
export const CURATED_CLOUD_MODELS = [
  'glm-5.1:cloud',
  'glm-4.7:cloud',
  'minimax-m2.5:cloud',
  'minimax-m2.1:cloud',
  'kimi-k2.7-code:cloud',
  'kimi-k2.6:cloud',
  'qwen3-coder:cloud',
  'gpt-oss:120b-cloud',
  'gpt-oss:20b-cloud',
  'gemma4:cloud',
  'deepseek-v4-flash:cloud',
] as const;

let cache: { at: number; models: string[] } | null = null;

/**
 * Models already present on the configured Ollama host that look like cloud.
 */
export function cloudModelsFromLocalTags(tags: string[]): string[] {
  return [...new Set(tags.filter(isCloudModelTag))].sort();
}

/**
 * Fetch public catalog from ollama.com and merge with curated + local cloud tags.
 */
export async function listOllamaCloudModels(opts?: {
  localTags?: string[];
  timeoutMs?: number;
}): Promise<string[]> {
  const local = cloudModelsFromLocalTags(opts?.localTags ?? []);
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return mergeCloudLists(cache.models, local);
  }

  try {
    const res = await fetch(CLOUD_TAGS_URL, {
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const fromApi = (data.models ?? [])
      .map((m) => toCloudModelTag(String(m.name || m.model || '')))
      .filter(Boolean);
    cache = { at: now, models: fromApi };
    return mergeCloudLists(fromApi, local);
  } catch (e) {
    logger.debug('llm', 'ollama.com cloud catalog fetch failed — using curated list');
    return mergeCloudLists([...CURATED_CLOUD_MODELS], local);
  }
}

function mergeCloudLists(...lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const m of list) {
      const t = m.trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
