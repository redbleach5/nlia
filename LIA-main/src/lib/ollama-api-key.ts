/**
 * Optional Ollama cloud API key (ollama.com) for Claude Code path B.
 * Stored in DB; never returned in full via Settings GET.
 */

import 'server-only';

import { db } from '@/lib/db';

const KEY = 'ollama_api_key';

/** Resolve key: DB setting, then process.env.OLLAMA_API_KEY. */
export async function getOllamaApiKey(): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key: KEY } });
    const fromDb = (row?.value ?? '').trim();
    if (fromDb) return fromDb;
  } catch {
    /* ignore */
  }
  return (process.env.OLLAMA_API_KEY ?? '').trim();
}

export async function hasOllamaApiKeyConfigured(): Promise<boolean> {
  return Boolean(await getOllamaApiKey());
}

/**
 * Persist key. Empty string clears DB (env fallback may still apply).
 */
export async function setOllamaApiKey(value: string | undefined): Promise<void> {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (!trimmed) {
    await db.setting.deleteMany({ where: { key: KEY } });
    return;
  }
  await db.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: trimmed },
    update: { value: trimmed },
  });
}
