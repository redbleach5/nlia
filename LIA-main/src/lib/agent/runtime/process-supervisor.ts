import 'server-only';

// ============================================================================
// Process Supervisor — long-running artifact runtimes (dev servers, scripts).
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { scrubCommandEnv } from '../tools/run-command';
import { emitAgentEvent } from '../events';
import { logger } from '@/lib/logger';
import type {
  ProjectDesign,
  RuntimeLogLine,
  RuntimeSessionSnapshot,
  RuntimeStatus,
} from './types';
import { htmlEntryFromPreviewUrl, previewUrlForDesign, RESERVED_PREVIEW_PORTS } from './project-manifest';
import { parseRuntimeScript } from './script-parse';
import type { ParsedScript } from './script-parse';
import { normalizeRuntimeScript } from './script-normalize';
import { probeHttpUrl } from './health';
import {
  clearRuntimePid,
  persistRuntimePid,
} from './orphan-pids';

export type { ParsedScript };
export { parseRuntimeScript };
export { htmlEntryFromPreviewUrl };

const MAX_LOG_LINES = 400;
const MAX_RESTARTS = 3;
const HEALTH_TIMEOUT_MS = 25_000;
const HEALTH_POLL_MS = 400;

type Session = {
  taskId: string;
  child: ChildProcess | null;
  status: RuntimeStatus;
  scriptKey?: string;
  command?: string;
  args: string[];
  cwd: string;
  port: number | null;
  previewUrl: string | null;
  restartCount: number;
  lastError: string | null;
  startedAt: number | null;
  logs: RuntimeLogLine[];
  killing: boolean;
};

const globalKey = '__lia_runtime_sessions__';
function getSessions(): Map<string, Session> {
  const g = globalThis as unknown as { [key: string]: Map<string, Session> };
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey];
}

function ensureSession(taskId: string): Session {
  const sessions = getSessions();
  let s = sessions.get(taskId);
  if (!s) {
    s = {
      taskId,
      child: null,
      status: 'idle',
      args: [],
      cwd: '',
      port: null,
      previewUrl: null,
      restartCount: 0,
      lastError: null,
      startedAt: null,
      logs: [],
      killing: false,
    };
    sessions.set(taskId, s);
  }
  return s;
}

function pushLog(session: Session, stream: RuntimeLogLine['stream'], text: string) {
  const line: RuntimeLogLine = { stream, text, ts: Date.now() };
  session.logs.push(line);
  if (session.logs.length > MAX_LOG_LINES) {
    session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  }
  emitAgentEvent({
    type: 'runtime_log',
    taskId: session.taskId,
    stream,
    text: text.slice(0, 2000),
    ts: line.ts,
  });
}

function emitStatus(session: Session) {
  emitAgentEvent({
    type: 'runtime_status',
    taskId: session.taskId,
    status: session.status,
    port: session.port,
    previewUrl: session.previewUrl,
    pid: session.child?.pid ?? null,
    restartCount: session.restartCount,
    lastError: session.lastError,
    scriptKey: session.scriptKey ?? null,
    ts: Date.now(),
  });
}

function setStatus(session: Session, status: RuntimeStatus, lastError?: string | null) {
  session.status = status;
  if (lastError !== undefined) session.lastError = lastError;
  emitStatus(session);
}

async function probePort(
  port: number,
  timeoutMs: number,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

/** One-shot TCP probe for hydrate (external serve may still be up). */
export async function probeLocalPort(port: number, timeoutMs = 600): Promise<boolean> {
  return probePort(port, timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill the whole process tree. On Windows `npx`/`cmd` leave orphaned `node serve`
 * if we only SIGTERM the shell PID — that orphan keeps :5173 and poisons the next task.
 */
async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const done = () => resolve();
      killer.on('exit', done);
      killer.on('error', done);
      setTimeout(done, 4000);
    });
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await sleep(800);
  try {
    if (!child.killed && child.exitCode == null) child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

async function waitPortFree(port: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeLocalPort(port, 200))) return true;
    await sleep(150);
  }
  return !(await probeLocalPort(port, 200));
}

/** Stop every supervised runtime that holds this port (except the given task). */
async function stopSessionsOnPort(port: number, exceptTaskId: string): Promise<void> {
  const sessions = [...getSessions().values()];
  for (const s of sessions) {
    if (s.taskId === exceptTaskId) continue;
    if (s.port !== port) continue;
    if (!s.child && s.status !== 'healthy' && s.status !== 'running' && s.status !== 'starting') {
      continue;
    }
    logger.info('agent', 'stopping prior runtime on shared preview port', {
      port,
      priorTaskId: s.taskId.slice(0, 8),
      forTaskId: exceptTaskId.slice(0, 8),
    });
    await stopRuntime(s.taskId);
  }
}

async function findFreePreviewPort(preferred: number): Promise<number> {
  const start = Number.isFinite(preferred) && preferred >= 1024 ? preferred : 5173;
  for (let i = 0; i < 60; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (RESERVED_PREVIEW_PORTS.has(port)) continue;
    // createServer is more reliable than a failed connect race
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (free) return port;
  }
  return start;
}

function rewritePreviewPort(url: string | null | undefined, port: number): string | null {
  if (!url) return `http://127.0.0.1:${port}/`;
  try {
    const u = new URL(url);
    u.port = String(port);
    return u.toString();
  } catch {
    return `http://127.0.0.1:${port}/`;
  }
}

/** Bust browser/iframe cache — same origin+path across sandboxes otherwise sticks. */
function withPreviewCacheBust(
  url: string | null,
  taskId: string,
  ts: number,
): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('lia', taskId.slice(0, 8));
    u.searchParams.set('t', String(ts));
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}lia=${taskId.slice(0, 8)}&t=${ts}`;
  }
}

function sessionSpawnFailed(session: Session): boolean {
  if (session.status === 'error' || session.status === 'stopped') return true;
  if (!session.child) return true;
  if (session.child.killed) return true;
  // exitCode set when process already exited
  if (session.child.exitCode != null) return true;
  return false;
}

/**
 * Before spawn: iframe HTML preview must have the entry file on disk,
 * otherwise `serve` returns a directory listing and falsely looks "healthy".
 */
export async function assertHtmlPreviewEntryExists(
  cwd: string,
  previewUrl: string | null | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = htmlEntryFromPreviewUrl(previewUrl);
  if (!entry) return { ok: true };
  try {
    await access(join(cwd, entry));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        `Нет файла точки входа «${entry}» — Preview покажет листинг каталога. `
        + `Сначала write_file ${entry}, затем runtime_start.`,
    };
  }
}

async function waitHealthy(session: Session): Promise<boolean> {
  if (!session.port) {
    // No port — treat as healthy if process still alive after short settle
    await sleep(800);
    if (session.child && !session.child.killed && session.status !== 'stopped' && session.status !== 'error') {
      setStatus(session, 'running');
      return true;
    }
    return false;
  }

  // 1) Port must accept TCP — abort early if spawn already failed (Windows ENOENT etc.)
  const portUp = await probePort(
    session.port,
    HEALTH_TIMEOUT_MS,
    () => sessionSpawnFailed(session),
  );
  if (!portUp) {
    if (sessionSpawnFailed(session) && session.lastError) {
      // Keep spawn/exit error — don't overwrite with generic port timeout.
      pushLog(session, 'system', session.lastError);
      return false;
    }
    setStatus(session, 'unhealthy', `Порт ${session.port} не отвечает за ${HEALTH_TIMEOUT_MS}ms`);
    pushLog(session, 'system', session.lastError ?? 'unhealthy');
    return false;
  }

  // Port responds but OUR child already died → leftover process from a prior task.
  if (sessionSpawnFailed(session)) {
    const err =
      `Порт ${session.port} отвечает, но процесс этой задачи уже завершился — `
      + `вероятно чужой leftover serve (предыдущий preview). Останови старый процесс или смени порт.`;
    setStatus(session, 'unhealthy', err);
    pushLog(session, 'system', err);
    return false;
  }

  // 2) For iframe preview — GET / must return 2xx/3xx (not just open port)
  const url = session.previewUrl || `http://127.0.0.1:${session.port}/`;
  const http = await probeHttpUrl(url, {
    timeoutMs: Math.min(12_000, HEALTH_TIMEOUT_MS),
    pollMs: HEALTH_POLL_MS,
  });
  if (!http.ok) {
    const err = `Preview ${url} не готов: ${http.error ?? 'no response'}`;
    setStatus(session, 'unhealthy', err);
    pushLog(session, 'system', err);
    return false;
  }

  // Re-check child after HTTP — stale port can answer while our spawn failed.
  if (sessionSpawnFailed(session)) {
    const err = `Preview ${url} ответил, но процесс задачи упал — не помечаем healthy`;
    setStatus(session, 'unhealthy', err);
    pushLog(session, 'system', err);
    return false;
  }

  setStatus(session, 'healthy');
  pushLog(session, 'system', `Health OK — ${url} → HTTP ${http.status ?? 200}`);
  return true;
}

function attachChild(session: Session, child: ChildProcess) {
  session.child = child;
  const pid = child.pid;
  if (pid) {
    void persistRuntimePid({
      taskId: session.taskId,
      pid,
      port: session.port,
      startedAt: session.startedAt ?? Date.now(),
    });
  }
  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length) pushLog(session, 'stdout', line);
    }
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length) pushLog(session, 'stderr', line);
    }
  });
  child.on('error', (err) => {
    if (session.killing) return;
    pushLog(session, 'system', `spawn error: ${err.message}`);
    setStatus(session, 'error', err.message);
  });
  child.on('exit', (code, signal) => {
    session.child = null;
    void clearRuntimePid(session.taskId);
    if (session.killing) {
      setStatus(session, 'stopped');
      return;
    }
    const msg = `process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    pushLog(session, 'system', msg);
    if (session.status === 'healthy' || session.status === 'running' || session.status === 'starting') {
      setStatus(session, code === 0 ? 'stopped' : 'error', code === 0 ? null : msg);
    }
  });
}

export type StartRuntimeInput = {
  taskId: string;
  cwd: string;
  script: string;
  scriptKey?: string;
  port?: number | null;
  previewUrl?: string | null;
};

export type StartRuntimeResult = {
  success: boolean;
  status: RuntimeStatus;
  error?: string;
  pid?: number | null;
  port?: number | null;
  previewUrl?: string | null;
  restartCount: number;
};

export async function startRuntime(input: StartRuntimeInput): Promise<StartRuntimeResult> {
  let preferredPort = input.port ?? 5173;
  if (RESERVED_PREVIEW_PORTS.has(preferredPort) || preferredPort < 1024) {
    preferredPort = 5173;
  }

  // Free the port among supervised sessions (previous task often leaves :5173 up).
  await stopSessionsOnPort(preferredPort, input.taskId);

  let port = preferredPort;
  if (await probeLocalPort(preferredPort, 250)) {
    // Still occupied after stopping our sessions — orphan or foreign process.
    await waitPortFree(preferredPort, 1500);
  }
  if (await probeLocalPort(preferredPort, 250)) {
    port = await findFreePreviewPort(preferredPort + 1);
    logger.info('agent', 'preview port busy — using free port', {
      taskId: input.taskId.slice(0, 8),
      wanted: preferredPort,
      using: port,
    });
  }

  const startedAt = Date.now();
  const script = normalizeRuntimeScript(input.script, port);
  const previewUrl = withPreviewCacheBust(
    rewritePreviewPort(input.previewUrl, port),
    input.taskId,
    startedAt,
  );

  const parsed = parseRuntimeScript(script);
  if (!parsed.ok) {
    return {
      success: false,
      status: 'error',
      error:
        parsed.error
        + ' — для статики используй: npx --yes serve -l 5173 (или src). Не передавай голый "vite".',
      restartCount: 0,
    };
  }

  const entryCheck = await assertHtmlPreviewEntryExists(input.cwd, previewUrl);
  if (!entryCheck.ok) {
    const session = ensureSession(input.taskId);
    session.cwd = input.cwd;
    session.port = port;
    session.previewUrl = previewUrl;
    setStatus(session, 'error', entryCheck.error);
    pushLog(session, 'system', entryCheck.error);
    return {
      success: false,
      status: 'error',
      error: entryCheck.error,
      port,
      previewUrl,
      restartCount: session.restartCount,
    };
  }

  const session = ensureSession(input.taskId);
  const prevCmd = `${session.command ?? ''} ${session.args.join(' ')}`.trim();
  const nextCmd = `${parsed.command} ${parsed.args.join(' ')}`.trim();
  const scriptChanged = Boolean(prevCmd && prevCmd !== nextCmd);

  if (session.child && !session.child.killed) {
    await stopRuntime(input.taskId);
  }

  // Heal with a different script gets a fresh restart budget.
  if (scriptChanged) {
    session.restartCount = 0;
    session.startedAt = null;
  }

  session.cwd = input.cwd;
  session.scriptKey = input.scriptKey;
  session.command = parsed.command;
  session.args = parsed.args;
  session.port = port;
  session.previewUrl = previewUrl;
  session.restartCount += session.startedAt ? 1 : 0;
  if (session.restartCount > MAX_RESTARTS) {
    const err = `Превышен лимит перезапусков (${MAX_RESTARTS})`;
    setStatus(session, 'error', err);
    return { success: false, status: 'error', error: err, restartCount: session.restartCount };
  }

  session.killing = false;
  session.startedAt = startedAt;
  setStatus(session, 'starting', null);
  pushLog(
    session,
    'system',
    `Starting: ${parsed.command} ${parsed.args.join(' ')} (cwd=${input.cwd}, port=${port})`,
  );

  try {
    // Windows: npx/npm are .cmd shims — spawn without shell → ENOENT.
    // Prefer *.cmd over shell:true (same pattern as run_command).
    const command =
      process.platform === 'win32'
      && /^(npx|npm|yarn|pnpm|bun)$/i.test(parsed.command)
        ? `${parsed.command}.cmd`
        : parsed.command;
    const child = spawn(command, parsed.args, {
      cwd: input.cwd,
      env: scrubCommandEnv() as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    attachChild(session, child);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(session, 'error', msg);
    return { success: false, status: 'error', error: msg, restartCount: session.restartCount };
  }

  // Let spawn 'error' fire before we start waiting on the port.
  await sleep(50);
  if (sessionSpawnFailed(session) && session.lastError) {
    return {
      success: false,
      status: session.status,
      error: session.lastError,
      pid: session.child?.pid ?? null,
      port: session.port,
      previewUrl: session.previewUrl,
      restartCount: session.restartCount,
    };
  }

  const healthy = await waitHealthy(session);
  return {
    success: healthy,
    status: session.status,
    error: healthy ? undefined : (session.lastError ?? 'runtime unhealthy'),
    pid: session.child?.pid ?? null,
    port: session.port,
    previewUrl: session.previewUrl,
    restartCount: session.restartCount,
  };
}

export async function startRuntimeFromDesign(
  taskId: string,
  cwd: string,
  design: ProjectDesign,
  scriptKey: 'dev' | 'start' = 'dev',
): Promise<StartRuntimeResult> {
  const script = design.scripts[scriptKey] ?? design.scripts.start ?? design.scripts.dev;
  if (!script) {
    return {
      success: false,
      status: 'error',
      error: `scripts.${scriptKey} missing in lia.project.json`,
      restartCount: 0,
    };
  }
  return startRuntime({
    taskId,
    cwd,
    script,
    scriptKey,
    port: design.preview.port ?? null,
    previewUrl: previewUrlForDesign(design),
  });
}

export async function stopRuntime(taskId: string): Promise<{ success: boolean; status: RuntimeStatus }> {
  const sessions = getSessions();
  const session = sessions.get(taskId);
  if (!session) return { success: true, status: 'idle' };

  session.killing = true;
  const child = session.child;
  const port = session.port;
  if (child) {
    pushLog(session, 'system', 'Stopping runtime…');
    await killProcessTree(child);
  }
  session.child = null;
  await clearRuntimePid(taskId);
  if (port != null) {
    await waitPortFree(port, 2500);
  }
  setStatus(session, 'stopped');
  logger.info('agent', 'runtime stopped', { taskId: taskId.slice(0, 8) });
  return { success: true, status: 'stopped' };
}

/** Stop every supervised runtime (e.g. before a new agent task claims preview). */
export async function stopAllRuntimes(): Promise<void> {
  const ids = [...getSessions().keys()];
  for (const id of ids) {
    await stopRuntime(id);
  }
}

export function getRuntimeLogs(taskId: string, limit = 80): RuntimeLogLine[] {
  const session = getSessions().get(taskId);
  if (!session) return [];
  return session.logs.slice(-Math.max(1, Math.min(limit, MAX_LOG_LINES)));
}

export function getRuntimeSnapshot(taskId: string): RuntimeSessionSnapshot | null {
  const session = getSessions().get(taskId);
  if (!session) return null;
  return {
    taskId,
    status: session.status,
    scriptKey: session.scriptKey,
    command: session.command,
    args: session.args,
    cwd: session.cwd || undefined,
    port: session.port,
    previewUrl: session.previewUrl,
    pid: session.child?.pid ?? null,
    restartCount: session.restartCount,
    lastError: session.lastError,
    startedAt: session.startedAt,
  };
}

export { MAX_RESTARTS };
export { stepsHaveRuntimeVerify } from './verify';
