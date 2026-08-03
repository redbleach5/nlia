#!/usr/bin/env node
/**
 * Освободить TCP-порт перед `bun run dev` — убивает только LISTEN-процессы (PID > 0).
 * Usage: node scripts/kill-port.mjs [port]
 */
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const port = process.argv[2] ?? '3000';

function killOnWindows() {
  let out = '';
  try {
    out = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    return [];
  }

  return [...new Set(
    out
      .trim()
      .split(/\s+/)
      .map(s => parseInt(s, 10))
      .filter(pid => Number.isInteger(pid) && pid > 0),
  )];
}

function killOnUnix() {
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: 'utf8' });
    return [...new Set(
      out
        .trim()
        .split('\n')
        .map(s => parseInt(s, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0),
    )];
  } catch {
    return [];
  }
}

const pids = process.platform === 'win32' ? killOnWindows() : killOnUnix();

if (pids.length === 0) {
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    console.log(`[kill-port] stopped PID ${pid} (port ${port})`);
  } catch {
    // already gone
  }
}

await sleep(500);
