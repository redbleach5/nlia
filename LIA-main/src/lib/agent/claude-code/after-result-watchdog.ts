/**
 * After Claude Code emits a stream-json `result` event, the CLI sometimes
 * keeps the process alive (esp. with local thinking models). We wait a short
 * grace window for trailing events, then SIGTERM the child.
 */

export const CC_AFTER_RESULT_GRACE_MS = 8_000;

export type AfterResultWatchdog = {
  /** Call when a parsed `result` event arrives (idempotent). */
  onResult: () => void;
  /** Cancel pending kill (e.g. process already closed). */
  clear: () => void;
  /** True after onResult was armed. */
  readonly armed: boolean;
};

/**
 * Pure-ish factory — injectable timers for unit tests.
 */
export function createAfterResultWatchdog(opts: {
  graceMs?: number;
  kill: () => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): AfterResultWatchdog {
  const graceMs = opts.graceMs ?? CC_AFTER_RESULT_GRACE_MS;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;

  const clear = () => {
    if (timer != null) {
      clearT(timer);
      timer = null;
    }
  };

  const onResult = () => {
    if (armed) return;
    armed = true;
    timer = setT(() => {
      timer = null;
      opts.kill();
    }, graceMs);
  };

  return {
    onResult,
    clear,
    get armed() {
      return armed;
    },
  };
}

/** Detect NDJSON result line without full stream parser (spawn hot path). */
export function streamChunkContainsResultEvent(chunk: string): boolean {
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    // Fast path — avoid JSON.parse on every line when possible.
    if (!/"type"\s*:\s*"result"/.test(t) && !t.includes('"type":"result"')) continue;
    try {
      const obj = JSON.parse(t) as { type?: string };
      if (obj.type === 'result') return true;
    } catch {
      /* ignore partial lines */
    }
  }
  return false;
}
