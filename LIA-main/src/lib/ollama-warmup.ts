import 'server-only';

// ============================================================================
// Ollama model warmup — preload + heartbeat.
// ============================================================================
//
// Problem: Ollama unloads models from VRAM after OLLAMA_KEEP_ALIVE (default
// 5 minutes) of inactivity. The first message after this idle window suffers
// a 5-15 second "cold start" while Ollama reloads the model into VRAM.
//
// Solution:
//   1. On server startup, fire a dummy embed + dummy chat call to preload
//      the configured models into VRAM. Fire-and-forget — does not block
//      startup, does not fail startup on error.
//   2. Every 4 minutes, fire another dummy call. OLLAMA_KEEP_ALIVE defaults
//      to 5 min, so 4 min heartbeat keeps models warm indefinitely.
//
// Remote Ollama (LAN GPU box):
//   Idle Mac UI must NOT pin large chat weights on the workstation forever —
//   that saturates remote VRAM while nobody chats. Default: warm embed only;
//   pin chat with LIA_WARMUP_REMOTE_CHAT=true if you want zero cold-start.
//
// Tunable via env:
//   LIA_WARMUP_ENABLED=false  → disable entirely (default: enabled)
//   LIA_WARMUP_INTERVAL_MS=240000 → heartbeat interval (default: 4 min)
//   LIA_WARMUP_REMOTE_CHAT=true → also preload chat model on non-loopback hosts
//
// HMR-safe: heartbeat timer stored on globalThis, survives dev hot-reload.
// Process exit: timer is .unref()'d — does not prevent Node shutdown.

import { logger } from './logger';
import { isOllamaLoopbackUrl } from './ollama-base-url';

const WARMUP_ENABLED = process.env.LIA_WARMUP_ENABLED !== 'false';
const WARMUP_INTERVAL_MS = parseInt(process.env.LIA_WARMUP_INTERVAL_MS ?? '240000', 10);
const WARMUP_REMOTE_CHAT = process.env.LIA_WARMUP_REMOTE_CHAT === 'true';

const globalKey = '__lia_ollama_warmup__';
const g = globalThis as unknown as { [key: string]: unknown };

interface WarmupState {
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
  lastHeartbeatAt: number | null;
  lastHeartbeatOk: boolean | null;
  preloadCalledFor: { chatModel: string | null; embedModel: string | null };
}

function getState(): WarmupState {
  if (!g[globalKey]) {
    g[globalKey] = {
      timer: null,
      startedAt: 0,
      lastHeartbeatAt: null,
      lastHeartbeatOk: null,
      preloadCalledFor: { chatModel: null, embedModel: null },
    } satisfies WarmupState;
  }
  return g[globalKey] as WarmupState;
}

/**
 * Warmup a single chat model by sending a minimal "hello" prompt.
 *
 * This is the smallest possible request that forces Ollama to load the
 * model into VRAM. We use the raw /api/chat endpoint (not the AI SDK)
 * because we want to control keep_alive explicitly and avoid the SDK's
 * retry/timeout overhead — warmup should be silent and best-effort.
 */
async function warmupChatModel(baseUrl: string, model: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ok' }],
        stream: false,
        options: {
          num_predict: 1,        // generate only 1 token — we just want model load
          temperature: 0,
          keep_alive: '10m',     // explicit keep-alive override
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('ollama', 'chat model warmup HTTP error', { model, status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('ollama', 'chat model warmup failed (non-fatal)', { model }, e);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Warmup the embed model with a single short text. nomic-embed-text loads
 * fast (~1s) but still benefits from preloading — first chat's recall()
 * would otherwise stall on this.
 */
async function warmupEmbedModel(baseUrl: string, model: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: 'warmup',
        keep_alive: '10m',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('ollama', 'embed model warmup HTTP error', { model, status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('ollama', 'embed model warmup failed (non-fatal)', { model }, e);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One warmup pass: load both chat + embed models if not already preloaded
 * for the current configured model names. If model name changes between
 * passes (user updated settings), the new model gets warmed up too.
 */
async function warmupPass(reason: 'preload' | 'heartbeat'): Promise<void> {
  const { getOllamaSettings, checkOllamaHealth } = await import('./ollama');

  // Skip if Ollama is down — no point spamming a dead server.
  const health = await checkOllamaHealth({ timeoutMs: 5_000 });
  if (!health.ok) {
    if (reason === 'preload') {
      logger.info('ollama', 'Skipping preload — Ollama not running');
    }
    return;
  }

  const settings = await getOllamaSettings();
  const state = getState();
  let didSomething = false;
  const remote = !isOllamaLoopbackUrl(settings.baseUrl);
  // Local Ollama: pin chat. Remote GPU box: don't keep 14B+ resident while the
  // Mac UI is idle (was driving critical VRAM pressure on the workstation).
  const pinChat = !remote || WARMUP_REMOTE_CHAT;

  // Warm up chat model if name changed or never preloaded.
  if (
    pinChat
    && settings.model
    && state.preloadCalledFor.chatModel !== settings.model
  ) {
    logger.info('ollama', `Preloading chat model: ${settings.model}`, { reason, remote });
    const ok = await warmupChatModel(settings.baseUrl, settings.model);
    if (ok) {
      state.preloadCalledFor.chatModel = settings.model;
      didSomething = true;
    }
  } else if (remote && !pinChat && reason === 'preload') {
    logger.info('ollama', 'Remote Ollama — skip chat preload (set LIA_WARMUP_REMOTE_CHAT=true to pin)', {
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
  }

  // Warm up embed model if name changed or never preloaded.
  // settings.embedModel can be 'auto' if not explicitly set — in that case
  // skip: the first real embed() call will resolve the model name and the
  // next heartbeat will pick it up.
  if (settings.embedModel && settings.embedModel !== 'auto' && state.preloadCalledFor.embedModel !== settings.embedModel) {
    logger.info('ollama', `Preloading embed model: ${settings.embedModel}`, { reason });
    const ok = await warmupEmbedModel(settings.baseUrl, settings.embedModel);
    if (ok) {
      state.preloadCalledFor.embedModel = settings.embedModel;
      didSomething = true;
    }
  }

  state.lastHeartbeatAt = Date.now();
  state.lastHeartbeatOk = didSomething || state.preloadCalledFor.chatModel !== null;

  if (reason === 'heartbeat' && didSomething) {
    logger.debug('ollama', 'Heartbeat reloaded model(s) after settings change');
  }
}

/**
 * Start the warmup loop. Called from server-startup.ts once.
 *
 * Idempotent: if called again (e.g. after HMR), it no-ops — only one
 * timer per process. The first warmupPass runs immediately (preload);
 * subsequent passes run every LIA_WARMUP_INTERVAL_MS (heartbeat).
 */
export async function startOllamaWarmup(): Promise<void> {
  if (typeof window !== 'undefined') return;  // server-only
  if (!WARMUP_ENABLED) {
    logger.info('ollama', 'Ollama warmup disabled (LIA_WARMUP_ENABLED=false)');
    return;
  }

  const state = getState();
  if (state.timer) {
    return;  // already started
  }

  state.startedAt = Date.now();

  // First pass: fire-and-forget. Doesn't block startup.
  warmupPass('preload').catch((e) => {
    logger.warn('ollama', 'Initial preload failed (non-fatal)', {}, e);
  });

  // Heartbeat: every 4 minutes (default), .unref()'d so it doesn't prevent shutdown.
  state.timer = setInterval(() => {
    warmupPass('heartbeat').catch((e) => {
      logger.warn('ollama', 'Heartbeat failed (non-fatal)', {}, e);
    });
  }, WARMUP_INTERVAL_MS);
  state.timer.unref?.();

  logger.info('ollama', 'Ollama warmup started', {
    intervalMs: WARMUP_INTERVAL_MS,
    note: 'Keeps configured models in VRAM between requests',
  });
}

/**
 * Stop the warmup loop. Called on process exit (best-effort cleanup).
 */
export function stopOllamaWarmup(): void {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    logger.info('ollama', 'Ollama warmup stopped');
  }
}
