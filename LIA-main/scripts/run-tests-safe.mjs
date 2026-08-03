#!/usr/bin/env node
/**
 * Safe test run — stops Lia on :3000 (SQLite lock), runs suites, restarts dev server.
 *
 * Usage:
 *   node scripts/run-tests-safe.mjs
 *   node scripts/run-tests-safe.mjs --no-restart
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LIA_PORT = 3000;

const args = process.argv.slice(2);
const noRestart = args.includes('--no-restart');

function parseVitestSummary(out) {
  const testsIdx = out.lastIndexOf('Tests ');
  const slice = testsIdx >= 0 ? out.slice(testsIdx) : out;
  const passed = slice.match(/(\d+)\s+passed/);
  const failed = slice.match(/(\d+)\s+failed/);
  const total = slice.match(/\((\d+)\)/);
  const p = passed ? parseInt(passed[1], 10) : 0;
  const f = failed ? parseInt(failed[1], 10) : 0;
  const t = total ? parseInt(total[1], 10) : p + f;
  return { p, f, t, ok: f === 0 && t > 0 };
}

async function stopLiaDevServer() {
  const killScript = join(PROJECT_ROOT, 'scripts', 'kill-port.mjs');
  try {
    await execFileAsync(process.execPath, [killScript, String(LIA_PORT)], {
      cwd: PROJECT_ROOT,
    });
  } catch { /* port already free */ }
  await new Promise(r => setTimeout(r, 3000));
}

function startLiaDevServer() {
  console.log(`▶️  Starting Lia on http://localhost:${LIA_PORT}`);
  const child = spawn('bun', ['run', 'dev'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const SUITES = [
  { name: 'Core', pattern: 'tests/core/' },
  { name: 'Unit (Security)', pattern: 'tests/unit/' },
  { name: 'Knowledge Base', pattern: 'tests/kb/' },
  { name: 'Integration (Mock)', pattern: 'tests/integration/' },
  { name: 'Paths & Complexity', pattern: 'tests/paths.test.ts tests/task-complexity.test.ts' },
];

async function runSuite(vitestBin, suite) {
  const vitestArgs = [
    'run',
    '--config', 'vitest.config.mts',
    '--reporter=verbose',
    '--test-timeout=60000',
    '--pool=forks',
    '--maxWorkers=1',
  ];
  for (const p of suite.pattern.split(' ')) {
    if (p.trim()) vitestArgs.push(p.trim());
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(vitestBin, vitestArgs, {
      cwd: PROJECT_ROOT,
      timeout: withJudge ? 300_000 : 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const { p, f, t, ok } = parseVitestSummary(stdout + stderr);
    console.log(`${ok ? '✅' : '❌'} ${suite.name}: ${p}/${t} passed${f ? `, ${f} failed` : ''} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return { ok, passed: p, failed: f, total: t };
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    const { p, f, t } = parseVitestSummary(out);
    console.log(`❌ ${suite.name}: ${p}/${t} passed, ${f} failed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    if (f > 0 && f <= 3) {
      out.split('\n').filter(l => l.includes('FAIL ')).slice(0, 3)
        .forEach(l => console.log(`   ${l.trim()}`));
    }
    return { ok: false, passed: p, failed: f, total: t };
  }
}

async function main() {
  const vitestBin = join(PROJECT_ROOT, 'node_modules', '.bin', 'vitest');
  if (!existsSync(vitestBin)) {
    console.error('❌ vitest not found — run bun install first');
    process.exit(1);
  }

  console.log(`📁 ${PROJECT_ROOT}`);
  console.log('');
  console.log(`⏹  Freeing port ${LIA_PORT} (Lia dev server holds db/custom.db)`);
  await stopLiaDevServer();
  console.log('');

  const results = [];
  for (const suite of SUITES) {
    results.push(await runSuite(vitestBin, suite));
  }

  console.log('');
  const failedSuites = results.filter(r => !r.ok).length;
  const totalPassed = results.reduce((s, r) => s + (r.passed ?? 0), 0);
  const totalFailed = results.reduce((s, r) => s + (r.failed ?? 0), 0);

  if (failedSuites === 0) {
    console.log(`🎉 All suites passed (${totalPassed} tests)`);
  } else {
    console.log(`⚠️  ${failedSuites} suite(s) failed (${totalPassed} passed, ${totalFailed} failed)`);
  }

  if (!noRestart) {
    startLiaDevServer();
  }

  process.exit(failedSuites > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
