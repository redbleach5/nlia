#!/usr/bin/env node
// ============================================================================
// ollama-restore.mjs — restore Ollama models from backup JSON.
// ============================================================================
//
// Restores models produced by ollama-backup.mjs. For each model in the backup:
//
//   1. If the model has a custom Modelfile (contains FROM <base> + system
//      prompt, adapters, parameters): write it to a temp .modelfile and run
//      `ollama create <name> -f <temp>`. This recreates the custom model
//      from its base + customisations.
//
//   2. If the model has NO custom Modelfile (standard registry pull): run
//      `ollama pull <name>`. This downloads the original model from the
//      Ollama registry.
//
// What is NOT restored (cannot be from a backup JSON):
//   - Inference state (conversations) — out of scope
//   - The base model weights for custom Modelfiles — `ollama create` will
//     auto-pull the base if not present, but you need internet access.
//
// Usage:
//   node scripts/ollama-restore.mjs ollama-backup-2026-07-05.json
//   node scripts/ollama-restore.mjs backup.json --dry-run    # show what would happen
//   node scripts/ollama-restore.mjs backup.json --only qwen3:8b,nomic-embed-text
//
// Exit codes:
//   0 — all models restored (or dry-run succeeded)
//   1 — backup file not found / invalid JSON
//   2 — Ollama CLI not installed
//   3 — some models failed (see output for details)

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { execSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';

function checkOllamaCli() {
  try {
    const v = execSync('ollama --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return v;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/ollama-restore.mjs <backup.json> [--dry-run] [--only=model1,model2]');
    process.exit(1);
  }
  const backupPath = resolve(args[0]);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',').map(s => s.trim()).filter(Boolean) : null;
  return { backupPath, dryRun, only };
}

function isCustomModelfile(modelfile) {
  if (!modelfile) return false;
  // A "custom" modelfile has more than just "FROM <base>\n". It typically
  // has SYSTEM, PARAMETER, ADAPTER, or TEMPLATE directives.
  const lines = modelfile.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length <= 1) return false;
  return lines.some(l => /^(SYSTEM|PARAMETER|ADAPTER|TEMPLATE|LICENSE)\b/i.test(l));
}

function runOllamaCreate(name, modelfileContent) {
  const tmpFile = join(tmpdir(), `ollama-restore-${Date.now()}.modelfile`);
  writeFileSync(tmpFile, modelfileContent, 'utf8');
  try {
    const result = spawnSync('ollama', ['create', name, '-f', tmpFile], {
      stdio: 'inherit',
    });
    return result.status === 0;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function runOllamaPull(name) {
  const result = spawnSync('ollama', ['pull', name], {
    stdio: 'inherit',
  });
  return result.status === 0;
}

function modelExists(name) {
  try {
    const r = execSync(`ollama list`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return r.split('\n').some(line => line.startsWith(name + '\t') || line.startsWith(name + ' '));
  } catch {
    return false;
  }
}

function main() {
  const { backupPath, dryRun, only } = parseArgs(process.argv);

  // 1. Check Ollama CLI
  const ollamaVersion = checkOllamaCli();
  if (!ollamaVersion) {
    console.error('✗ Ollama CLI not found. Install from https://ollama.com');
    process.exit(2);
  }
  console.log(`Ollama CLI: ${ollamaVersion}`);

  // 2. Read backup file
  if (!existsSync(backupPath)) {
    console.error(`✗ Backup file not found: ${backupPath}`);
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  } catch (e) {
    console.error(`✗ Invalid JSON in backup file: ${e.message}`);
    process.exit(1);
  }

  if (backup.schema !== 'ollama-backup-v1') {
    console.error(`✗ Unknown backup schema: ${backup.schema}`);
    process.exit(1);
  }

  console.log(`Backup: ${backupPath}`);
  console.log(`Created: ${backup.createdAt}`);
  console.log(`Models: ${backup.models.length}`);
  if (only) {
    console.log(`Filtering to: ${only.join(', ')}`);
  }
  console.log(dryRun ? '\nDRY RUN — no changes will be made\n' : '');

  // 3. Restore each model
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const failures = [];

  for (const m of backup.models) {
    const name = m.name;
    if (only && !only.includes(name)) continue;

    process.stdout.write(`  ${name.padEnd(40)} `);

    const custom = isCustomModelfile(m.modelfile);
    const exists = modelExists(name);

    if (exists && !custom) {
      console.log('skip (already installed, standard pull)');
      skipCount++;
      continue;
    }

    if (exists && custom) {
      // For custom models, we still restore — the modelfile may have changed
      console.log('(exists, recreating with backed-up Modelfile)');
    } else if (custom) {
      console.log('(custom Modelfile)');
    } else {
      console.log('(standard pull)');
    }

    if (dryRun) {
      if (custom) {
        console.log(`      would run: ollama create ${name} -f <temp-modelfile>`);
        console.log(`      Modelfile preview:\n${m.modelfile.split('\n').slice(0, 8).map(l => `        ${l}`).join('\n')}${m.modelfile.split('\n').length > 8 ? '\n        ...' : ''}`);
      } else {
        console.log(`      would run: ollama pull ${name}`);
      }
      okCount++;
      continue;
    }

    const success = custom
      ? runOllamaCreate(name, m.modelfile)
      : runOllamaPull(name);

    if (success) {
      console.log(`  ✓ ${name}`);
      okCount++;
    } else {
      console.log(`  ✗ ${name} failed`);
      failures.push(name);
      failCount++;
    }
  }

  console.log('');
  console.log(`Done: ${okCount} restored, ${skipCount} skipped${failCount ? `, ${failCount} failed` : ''}`);

  if (failures.length > 0) {
    console.log('\nFailed models:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(3);
  }
}

main();
