// Effective Ollama settings: DB (UI) is source of truth; .env is bootstrap seed only.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_EMBED = 'nomic-embed-text';

function parseDotEnv(projectDir) {
  const out = {};
  const path = join(projectDir, '.env');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readDbOllamaSettings(projectDir) {
  const dbPath = join(projectDir, 'db', 'custom.db');
  if (!existsSync(dbPath)) return {};
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return {};
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT key, value FROM Setting WHERE key IN (?, ?, ?, ?)`,
    ).all('ollama_base_url', 'ollama_model', 'ollama_agent_model', 'ollama_embed_model');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  } finally {
    db.close();
  }
}

/**
 * @param {string} projectDir
 */
export function getEffectiveOllamaSettings(projectDir) {
  const env = parseDotEnv(projectDir);
  const db = readDbOllamaSettings(projectDir);

  const baseUrl = db.ollama_base_url || env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  const model = db.ollama_model || env.OLLAMA_MODEL || DEFAULT_MODEL;
  const agentModel = db.ollama_agent_model ?? env.OLLAMA_AGENT_MODEL ?? '';
  const embedRaw = db.ollama_embed_model ?? env.OLLAMA_EMBED_MODEL ?? '';
  const embedModel = embedRaw || DEFAULT_EMBED;

  return {
    baseUrl,
    model,
    agentModel: agentModel || '',
    embedModel,
    source: db.ollama_model ? 'db' : (env.OLLAMA_MODEL ? 'env' : 'default'),
  };
}
