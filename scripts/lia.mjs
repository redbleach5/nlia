#!/usr/bin/env node
/**
 * Lia v3 — start / stop / restart / status for the local dev stack.
 *
 * Usage:
 *   node scripts/lia.mjs start|stop|restart|status [--fg]
 *   npm start | npm stop | npm run restart | npm run status
 *
 * Starts backend + frontend via `npm run dev`, frees stale port listeners,
 * writes data/lia-dev.pid, waits for /api/health.
 */

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const PID_FILE = join(DATA_DIR, "lia-dev.pid");
const LOG_FILE = join(DATA_DIR, "lia-dev.log");

const DEFAULT_BACKEND_PORT = 8787;
const DEFAULT_FRONTEND_PORT = 5173;
const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 500;

function log(msg) {
  console.log(`[lia] ${msg}`);
}

// ─── env ────────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    const quoted =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"));
    if (quoted) {
      val = val.slice(1, -1);
    } else {
      // Strip unquoted inline comments: KEY=value  # note
      const hash = val.search(/\s+#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function ports() {
  loadDotEnv();
  const backend = Number(process.env.LIA_BACKEND_PORT ?? DEFAULT_BACKEND_PORT);
  const frontend = Number(process.env.VITE_PORT ?? DEFAULT_FRONTEND_PORT);
  return {
    backend: Number.isFinite(backend) && backend > 0 ? backend : DEFAULT_BACKEND_PORT,
    frontend:
      Number.isFinite(frontend) && frontend > 0 ? frontend : DEFAULT_FRONTEND_PORT,
  };
}

// ─── process / ports ────────────────────────────────────────────────

function pidsListeningOn(port) {
  if (process.platform === "win32") {
    // Prefer PowerShell; fall back to netstat (works without admin on most setups).
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const pids = [
        ...new Set(
          out
            .trim()
            .split(/\s+/)
            .map((s) => parseInt(s, 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        ),
      ];
      if (pids.length > 0) return pids;
    } catch {
      /* fall through */
    }
    try {
      const out = execSync("netstat -ano -p tcp", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        //  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    12345
        if (!/LISTENING/i.test(line)) continue;
        const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i"));
        if (m) pids.add(parseInt(m[1], 10));
      }
      return [...pids].filter((pid) => pid > 0);
    } catch {
      return [];
    }
  }
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return [
      ...new Set(
        out
          .trim()
          .split("\n")
          .map((s) => parseInt(s, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    ];
  } catch {
    return [];
  }
}

function killPid(pid, _signal = "SIGTERM") {
  try {
    if (process.platform === "win32") {
      // /T = kill child tree (npm.cmd → node → tsx/vite)
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, _signal); // process group when detached
      } catch {
        process.kill(pid, _signal);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(port, label) {
  const pids = pidsListeningOn(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    if (killPid(pid, "SIGTERM")) log(`stopped PID ${pid} on ${label} :${port}`);
  }
  await sleep(400);
  for (const pid of pidsListeningOn(port)) {
    if (killPid(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL")) {
      log(`force-stopped PID ${pid} on ${label} :${port}`);
    }
  }
  await sleep(200);
}

function portOpen(port) {
  return pidsListeningOn(port).length > 0;
}

function readPidFile() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(PID_FILE, "utf8"));
    if (!raw || typeof raw.pid !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

function writePidFile(meta) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function clearPidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

// ─── health ─────────────────────────────────────────────────────────

async function waitForHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not ready */
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

// ─── commands ───────────────────────────────────────────────────────

async function cmdStop({ quiet = false } = {}) {
  const { backend, frontend } = ports();
  const meta = readPidFile();

  if (meta?.pid && isPidAlive(meta.pid)) {
    if (killPid(meta.pid, "SIGTERM") && !quiet) {
      log(`stopped supervised process (PID ${meta.pid})`);
    }
    await sleep(500);
    if (isPidAlive(meta.pid)) {
      killPid(meta.pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    }
  }

  await freePort(backend, "backend");
  await freePort(frontend, "frontend");
  clearPidFile();

  if (!quiet) {
    const still = pidsListeningOn(backend).length + pidsListeningOn(frontend).length;
    log(
      still === 0
        ? "stopped"
        : process.platform === "win32"
          ? "ports may still be busy — check netstat -ano"
          : "ports may still be busy — check lsof",
    );
  }
}

async function cmdStart({ foreground = false } = {}) {
  const { backend, frontend } = ports();
  const isWin = process.platform === "win32";
  // On Windows npm is a .cmd shim — must use shell, otherwise spawn often fails (EINVAL).
  const npmCmd = isWin ? "npm.cmd" : "npm";
  const args = ["run", "dev"];
  const env = {
    ...process.env,
    LIA_BACKEND_PORT: String(backend),
    VITE_PORT: String(frontend),
  };
  const spawnOpts = (extra) => ({
    cwd: ROOT,
    env,
    shell: isWin,
    windowsHide: true,
    ...extra,
  });

  if (!foreground && portOpen(backend) && portOpen(frontend)) {
    const ok = await waitForHealth(backend, 3_000);
    if (ok) {
      log(`already running — backend :${backend}, frontend :${frontend}`);
      log(`  UI  http://127.0.0.1:${frontend}`);
      log(`  API http://127.0.0.1:${backend}/api/health`);
      return;
    }
  }

  await cmdStop({ quiet: true });
  mkdirSync(DATA_DIR, { recursive: true });

  if (foreground) {
    log(`starting (foreground) — backend :${backend}, frontend :${frontend}`);
    const child = spawn(npmCmd, args, spawnOpts({ stdio: "inherit" }));
    const onSignal = () => {
      if (child.pid) killPid(child.pid);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const code = await new Promise((resolveCode) => {
      child.on("exit", (c) => resolveCode(c ?? 0));
    });
    process.exit(code);
  }

  log(`starting — backend :${backend}, frontend :${frontend}`);
  log(`logs → ${LOG_FILE}`);

  const fd = openSync(LOG_FILE, "a");
  const child = spawn(
    npmCmd,
    args,
    spawnOpts({
      detached: true,
      stdio: ["ignore", fd, fd],
    }),
  );
  child.unref();

  if (!child.pid) {
    log("failed to spawn npm run dev");
    process.exit(1);
  }

  writePidFile({
    pid: child.pid,
    backend,
    frontend,
    startedAt: new Date().toISOString(),
    log: LOG_FILE,
  });

  const ok = await waitForHealth(backend);
  if (!ok) {
    log("backend health check timed out — see log file");
    log(`  ${LOG_FILE}`);
    process.exit(1);
  }

  const feDeadline = Date.now() + 20_000;
  while (Date.now() < feDeadline && !portOpen(frontend)) {
    await sleep(300);
  }

  log("ready");
  log(`  UI  http://127.0.0.1:${frontend}`);
  log(`  API http://127.0.0.1:${backend}/api/health`);
}

async function cmdStatus() {
  const { backend, frontend } = ports();
  const meta = readPidFile();
  const bePids = pidsListeningOn(backend);
  const fePids = pidsListeningOn(frontend);

  let health = "down";
  try {
    const res = await fetch(`http://127.0.0.1:${backend}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    health = res.ok ? "ok" : `http ${res.status}`;
  } catch {
    health = "unreachable";
  }

  log(`backend  :${backend}  listen=${bePids.join(",") || "—"}  health=${health}`);
  log(`frontend :${frontend}  listen=${fePids.join(",") || "—"}`);
  if (meta) {
    log(
      `supervisor PID ${meta.pid} (${isPidAlive(meta.pid) ? "alive" : "stale"}) started ${meta.startedAt}`,
    );
    if (meta.log) log(`log ${meta.log}`);
  } else {
    log("no PID file");
  }

  process.exit(bePids.length > 0 && health === "ok" ? 0 : 1);
}

async function cmdRestart(opts) {
  await cmdStop();
  await sleep(300);
  await cmdStart(opts);
}

function printHelp() {
  console.log(`Usage: node scripts/lia.mjs <start|stop|restart|status> [--fg]

  start       Free ports, start backend+frontend in background, wait for health
  start --fg  Same, but attach to terminal (Ctrl+C stops)
  stop        Stop supervised process + free backend/frontend ports
  restart     stop → start
  status      Ports, health, PID file

Ports from .env: LIA_BACKEND_PORT (default 8787), VITE_PORT (default 5173).
npm aliases: npm start | npm stop | npm run restart | npm run status`);
}

const cmd = (process.argv[2] ?? "help").toLowerCase();
const foreground = process.argv.includes("--fg") || process.argv.includes("--foreground");

try {
  switch (cmd) {
    case "start":
    case "up":
      await cmdStart({ foreground });
      break;
    case "stop":
    case "down":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart({ foreground });
      break;
    case "status":
      await cmdStatus();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      printHelp();
      process.exit(1);
  }
} catch (err) {
  console.error("[lia] error:", err);
  process.exit(1);
}
