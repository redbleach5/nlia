#!/usr/bin/env node
// ============================================================================
// ollama-backup.mjs — export installed Ollama models + custom Modelfiles.
// ============================================================================
//
// Problem: When migrating to a new machine or reinstalling Ollama, you have
// to remember which models were installed and recreate any custom Modelfiles
// (with system prompts, parameters, adapters). This script captures that
// state into a single JSON file for one-shot restore.
//
// What gets backed up:
//   - List of installed models (name, size, digest, modified date)
//   - For each model: full Modelfile via /api/show
//   - Ollama version (if available via /api/version)
//
// What is NOT backed up (cannot be):
//   - Inference state (conversations, KV cache)
//   - Custom system-level OLLAMA_* env vars (out of scope — capture manually)
//
// Usage:
//   node scripts/ollama-backup.mjs                    # → ollama-backup-YYYY-MM-DD.json
//   node scripts/ollama-backup.mjs /path/to/out.json  # custom output path
//   OLLAMA_BASE_URL=http://host:11434 node scripts/ollama-backup.mjs
//
// Exit codes:
//   0 — success (or partial: some models failed but file written)
//   1 — Ollama not reachable
//   2 — file write error

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getEffectiveOllamaSettings } from './lib/effective-ollama.mjs';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const effective = getEffectiveOllamaSettings(PROJECT_DIR);
// Explicit shell env wins for one-shot overrides (OLLAMA_BASE_URL=… node …).
const BASE_URL = process.env.OLLAMA_BASE_URL || effective.baseUrl;
const outPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(`ollama-backup-${new Date().toISOString().slice(0, 10)}.json`);

async function fetchJson(url, opts = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    // Wrap network errors (ECONNREFUSED, ETIMEDOUT, DNS failures) into a
    // structured shape so callers can distinguish "Ollama not running" from
    // "Ollama returned an HTTP error".
    const err = e instanceof Error ? e : new Error(String(e));
    const networkError = err.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : (err.cause?.code || err.message || 'unknown');
    return { ok: false, status: 0, json: null, text: '', networkError };
  } finally {
    clearTimeout(t);
  }
}

async function getOllamaVersion() {
  try {
    const r = await fetchJson(`${BASE_URL}/api/version`, {}, 5_000);
    if (r.ok && r.json?.version) return r.json.version;
  } catch { /* ignore — old version or unreachable */ }
  return null;
}

async function listModels() {
  const r = await fetchJson(`${BASE_URL}/api/tags`, {}, 10_000);
  if (!r.ok || !r.json) {
    if (r.networkError) {
      const err = new Error(`cannot reach Ollama at ${BASE_URL} (${r.networkError})`);
      err.cause = { baseUrl: BASE_URL, networkError: r.networkError };
      throw err;
    }
    const msg = r.text?.slice(0, 200) || `HTTP ${r.status}`;
    const err = new Error(`/api/tags failed: ${msg}`);
    err.cause = { baseUrl: BASE_URL, status: r.status };
    throw err;
  }
  return r.json.models ?? [];
}

async function getModelDetails(name) {
  const r = await fetchJson(`${BASE_URL}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, 60_000);
  if (!r.ok || !r.json) {
    return { ok: false, error: `HTTP ${r.status}: ${r.text?.slice(0, 200)}` };
  }
  return { ok: true, details: r.json };
}

async function main() {
  console.log(`Ollama backup → ${outPath}`);
  console.log(`Base URL: ${BASE_URL}`);

  const version = await getOllamaVersion();
  if (version) console.log(`Ollama version: ${version}`);
  else console.log('Ollama version: unknown (old version?)');

  let models;
  try {
    models = await listModels();
  } catch (e) {
    console.error(`\n✗ Cannot reach Ollama at ${BASE_URL}`);
    console.error(`  ${e.message}`);
    console.error(`\n  Make sure 'ollama serve' is running.`);
    process.exit(1);
  }

  console.log(`\nFound ${models.length} model(s):`);

  const backup = {
    schema: 'ollama-backup-v1',
    createdAt: new Date().toISOString(),
    ollamaVersion: version,
    baseUrl: BASE_URL,
    models: [],
    errors: [],
  };

  let okCount = 0;
  let failCount = 0;

  for (const m of models) {
    const name = m.name ?? m.model;
    if (!name) {
      backup.errors.push({ model: '(unknown)', error: 'no name field' });
      failCount++;
      continue;
    }
    process.stdout.write(`  ${name.padEnd(40)} `);
    const result = await getModelDetails(name);
    if (!result.ok) {
      console.log(`✗ ${result.error}`);
      backup.errors.push({ model: name, error: result.error });
      failCount++;
      continue;
    }
    console.log(`✓ ${m.details?.parameter_size ?? '?'}`);
    backup.models.push({
      name,
      digest: m.digest,
      size: m.size,
      modifiedAt: m.modified_at,
      details: m.details,
      modelfile: result.details.modelfile ?? null,
      parameters: result.details.parameters ?? null,
      template: result.details.template ?? null,
      license: result.details.license ?? null,
      modelInfo: result.details.model_info ?? null,
    });
    okCount++;
  }

  try {
    writeFileSync(outPath, JSON.stringify(backup, null, 2));
  } catch (e) {
    console.error(`\n✗ Failed to write backup file: ${e.message}`);
    process.exit(2);
  }

  console.log(`\n✓ Backed up ${okCount} model(s)${failCount ? `, ${failCount} failed` : ''}`);
  console.log(`  File: ${outPath}`);
  console.log(`  Size: ${(JSON.stringify(backup).length / 1024).toFixed(1)} KB`);

  if (failCount > 0) {
    console.log(`\n  Errors (see backup.errors[] for details):`);
    for (const e of backup.errors) {
      console.log(`    ${e.model}: ${e.error}`);
    }
  }

  console.log(`\nTo restore: node scripts/ollama-restore.mjs ${outPath}`);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
