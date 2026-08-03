import 'server-only';

import { db } from '@/lib/db';

const KEY_ENABLED = 'claude_code_enabled';
const KEY_MODEL = 'claude_code_model';

export type ClaudeCodeSettings = {
  enabled: boolean;
  /** Override model for `claude --model`; empty = use agent slot. */
  model: string;
};

export async function getClaudeCodeSettings(): Promise<ClaudeCodeSettings> {
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: [KEY_ENABLED, KEY_MODEL] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      enabled: map.get(KEY_ENABLED) === '1' || map.get(KEY_ENABLED) === 'true',
      model: (map.get(KEY_MODEL) ?? '').trim(),
    };
  } catch {
    return { enabled: false, model: '' };
  }
}

export async function setClaudeCodeSettings(params: {
  enabled?: boolean;
  model?: string;
}): Promise<ClaudeCodeSettings> {
  if (params.enabled !== undefined) {
    const value = params.enabled ? '1' : '0';
    await db.setting.upsert({
      where: { key: KEY_ENABLED },
      create: { key: KEY_ENABLED, value },
      update: { value },
    });
  }
  if (params.model !== undefined) {
    const value = params.model.trim();
    if (!value) {
      await db.setting.deleteMany({ where: { key: KEY_MODEL } });
    } else {
      await db.setting.upsert({
        where: { key: KEY_MODEL },
        create: { key: KEY_MODEL, value },
        update: { value },
      });
    }
  }
  return getClaudeCodeSettings();
}
