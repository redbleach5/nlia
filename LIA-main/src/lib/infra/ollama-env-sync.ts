import 'server-only';

// Ollama preferences: SQLite (UI) is the source of truth.
// .env OLLAMA_* values are bootstrap seed only (first launch when DB is empty).
// We never write OLLAMA_* back into the .env file.

import { db } from '../db';
import { logger } from '../logger';

const DB_KEYS = {
  baseUrl: 'ollama_base_url',
  model: 'ollama_model',
  agentModel: 'ollama_agent_model',
  secondaryModel: 'ollama_secondary_model',
  heavyModel: 'ollama_heavy_model',
  embedModel: 'ollama_embed_model',
} as const;

export type OllamaEnvSnapshot = {
  baseUrl: string;
  model: string;
  agentModel: string;
  secondaryModel?: string;
  heavyModel?: string;
  embedModel: string;
};

/** Mirror effective Ollama settings into process.env (same-process CLI / helpers). */
export function applyOllamaToProcessEnv(snapshot: OllamaEnvSnapshot): void {
  process.env.OLLAMA_BASE_URL = snapshot.baseUrl;
  process.env.OLLAMA_MODEL = snapshot.model;
  if (snapshot.agentModel.trim()) {
    process.env.OLLAMA_AGENT_MODEL = snapshot.agentModel.trim();
  } else {
    delete process.env.OLLAMA_AGENT_MODEL;
  }
  const secondary = (snapshot.secondaryModel ?? '').trim();
  if (secondary) {
    process.env.OLLAMA_SECONDARY_MODEL = secondary;
  } else {
    delete process.env.OLLAMA_SECONDARY_MODEL;
  }
  const heavy = (snapshot.heavyModel ?? '').trim();
  if (heavy) {
    process.env.OLLAMA_HEAVY_MODEL = heavy;
  } else {
    delete process.env.OLLAMA_HEAVY_MODEL;
  }
  if (snapshot.embedModel.trim()) {
    process.env.OLLAMA_EMBED_MODEL = snapshot.embedModel.trim();
  } else {
    delete process.env.OLLAMA_EMBED_MODEL;
  }
}

/** After UI save — keep in-memory process.env in sync (no .env file write). */
export function mirrorOllamaToProcessEnv(snapshot: OllamaEnvSnapshot): void {
  applyOllamaToProcessEnv(snapshot);
}

async function seedDbFromSnapshot(snapshot: OllamaEnvSnapshot): Promise<void> {
  await db.setting.upsert({
    where: { key: DB_KEYS.baseUrl },
    create: { key: DB_KEYS.baseUrl, value: snapshot.baseUrl },
    update: { value: snapshot.baseUrl },
  });
  await db.setting.upsert({
    where: { key: DB_KEYS.model },
    create: { key: DB_KEYS.model, value: snapshot.model },
    update: { value: snapshot.model },
  });

  const agent = snapshot.agentModel.trim();
  if (agent) {
    await db.setting.upsert({
      where: { key: DB_KEYS.agentModel },
      create: { key: DB_KEYS.agentModel, value: agent },
      update: { value: agent },
    });
  } else {
    await db.setting.deleteMany({ where: { key: DB_KEYS.agentModel } });
  }

  const secondary = (snapshot.secondaryModel ?? '').trim();
  if (secondary) {
    await db.setting.upsert({
      where: { key: DB_KEYS.secondaryModel },
      create: { key: DB_KEYS.secondaryModel, value: secondary },
      update: { value: secondary },
    });
  } else {
    await db.setting.deleteMany({ where: { key: DB_KEYS.secondaryModel } });
  }

  const heavy = (snapshot.heavyModel ?? '').trim();
  if (heavy) {
    await db.setting.upsert({
      where: { key: DB_KEYS.heavyModel },
      create: { key: DB_KEYS.heavyModel, value: heavy },
      update: { value: heavy },
    });
  } else {
    await db.setting.deleteMany({ where: { key: DB_KEYS.heavyModel } });
  }

  const embed = snapshot.embedModel.trim();
  if (embed) {
    await db.setting.upsert({
      where: { key: DB_KEYS.embedModel },
      create: { key: DB_KEYS.embedModel, value: embed },
      update: { value: embed },
    });
  } else {
    await db.setting.deleteMany({ where: { key: DB_KEYS.embedModel } });
  }
}

let reconcileDone = false;

/** Test-only: allow re-running reconcile in unit tests. */
export function resetOllamaEnvReconcileForTests(): void {
  reconcileDone = false;
}

/**
 * On first server boot: seed DB from .env/bootstrap snapshot if empty.
 * When DB already has a model — only mirror into process.env (never rewrite .env).
 */
export async function reconcileOllamaEnvAndDb(snapshot: OllamaEnvSnapshot): Promise<void> {
  if (reconcileDone) return;
  reconcileDone = true;

  try {
    const row = await db.setting.findUnique({ where: { key: DB_KEYS.model } });
    const hasDbModel = !!row?.value?.trim();

    if (!hasDbModel) {
      await seedDbFromSnapshot(snapshot);
      applyOllamaToProcessEnv(snapshot);
      logger.info('llm', 'Ollama settings seeded from bootstrap (.env) into DB', {
        model: snapshot.model,
      });
      return;
    }

    applyOllamaToProcessEnv(snapshot);
    logger.debug('llm', 'Ollama settings loaded from DB (process.env mirrored)', {
      model: snapshot.model,
      agentModel: snapshot.agentModel || '(same as chat)',
      embedModel: snapshot.embedModel || 'auto',
    });
  } catch (e) {
    reconcileDone = false;
    logger.warn('llm', 'Ollama .env/DB reconcile failed (non-fatal)', {}, e);
  }
}
