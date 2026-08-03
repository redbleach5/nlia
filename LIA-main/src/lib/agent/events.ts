import 'server-only';

// Agent events — singleton EventEmitter для real-time обновлений UI.
//
// Runner эмитит события, SSE-эндпоинт подписывается и стримит клиенту.
// Один emitter на процесс — все активные task runners делят его.

import { EventEmitter } from 'events';

const globalKey = '__lia_agent_events__';

export type AgentExecutorKind = 'claude_code' | 'react';

export type AgentEvent =
  | { type: 'task_started'; taskId: string; goal: string; executor?: AgentExecutorKind; ts: number; eventId?: string }
  | { type: 'task_planning'; taskId: string; ts: number; eventId?: string }
  | {
      type: 'task_plan_ready';
      taskId: string;
      plan: { goal: string; steps: string[]; complexity: string; targetFiles?: string[] };
      executor?: AgentExecutorKind;
      ts: number;
      eventId?: string;
    }
  | { type: 'step_start'; taskId: string; step: number; maxSteps: number; thought: string; ts: number; eventId?: string }
  | { type: 'step_end'; taskId: string; step: number; action: string; observation: string; thought: string; durationMs: number; ts: number; eventId?: string }
  | { type: 'tool_start'; taskId: string; step: number; tool: string; input: unknown; ts: number; eventId?: string }
  | { type: 'tool_end'; taskId: string; step: number; tool: string; success: boolean; output: unknown; ts: number; eventId?: string }
  | { type: 'task_waiting_input'; taskId: string; question: string; ts: number; eventId?: string }
  | { type: 'task_synthesizing'; taskId: string; ts: number; eventId?: string }
  | { type: 'task_done'; taskId: string; resultSummary: string; chatMessageId?: string; ts: number; eventId?: string }
  | { type: 'task_failed'; taskId: string; error: string; chatMessageId?: string; ts: number; eventId?: string }
  | { type: 'task_cancelled'; taskId: string; chatMessageId?: string; ts: number; eventId?: string }
  | { type: 'artifact_saved'; taskId: string; step: number; filename: string; url: string; ts: number; eventId?: string }
  | {
      type: 'file_changed';
      taskId: string;
      step: number;
      changeId: string;
      path: string;
      tool: 'edit_file' | 'write_file';
      diff?: string;
      canUndo: boolean;
      /** Ask-mode: waiting for Apply (disk not yet written). */
      pending?: boolean;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'assistant_delta';
      taskId: string;
      text: string;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'edit_applied';
      taskId: string;
      changeId: string;
      path: string;
      tool: 'edit_file' | 'write_file';
      diff?: string;
      canUndo: boolean;
      step?: number;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'edit_rejected';
      taskId: string;
      changeId: string;
      path: string;
      step?: number;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'permission_request';
      taskId: string;
      requestId: string;
      kind: 'shell' | 'network' | 'mcp' | 'write';
      detail: string;
      payload?: unknown;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'design_proposed';
      taskId: string;
      design: {
        name: string;
        kind: string;
        stack: string[];
        tree: Array<{ path: string; role: string }>;
        scripts: Record<string, string | undefined>;
        preview: { type: string; port?: number; url?: string };
        entry?: string;
        acceptance: string;
        createdBy: 'lia';
      };
      autoAccepted: boolean;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'runtime_log';
      taskId: string;
      stream: 'stdout' | 'stderr' | 'system';
      text: string;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'runtime_status';
      taskId: string;
      status: string;
      port?: number | null;
      previewUrl?: string | null;
      pid?: number | null;
      restartCount?: number;
      lastError?: string | null;
      scriptKey?: string | null;
      ts: number;
      eventId?: string;
    };

function getEmitter(): EventEmitter {
  const g = globalThis as unknown as { [key: string]: unknown };
  if (!g[globalKey]) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100); // many SSE connections possible
    g[globalKey] = emitter;
  }
  return g[globalKey] as EventEmitter;
}

export function emitAgentEvent(event: AgentEvent) {
  const emitter = getEmitter();
  emitter.emit(`task:${event.taskId}`, event);
  emitter.emit('task:*', event); // wildcard for global listeners
  bufferEvent(event);
}

export function subscribeToTask(taskId: string, listener: (event: AgentEvent) => void): () => void {
  const emitter = getEmitter();
  const channel = `task:${taskId}`;
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}

/**
 * Get all events that have been buffered for a task (for replay on SSE reconnect).
 * Limited to last 100 events per task to bound memory.
 */
// HMR-safe: храним на globalThis, чтобы переживало hot-reload в dev.
const globalForBuffer = globalThis as unknown as { __liaEventBuffer?: Map<string, AgentEvent[]> };
const eventBuffer: Map<string, AgentEvent[]> =
  globalForBuffer.__liaEventBuffer ?? new Map<string, AgentEvent[]>();
globalForBuffer.__liaEventBuffer = eventBuffer;
const BUFFER_LIMIT = 100;

function bufferEvent(event: AgentEvent) {
  // runtime_log is high-volume — skip replay buffer (live SSE only).
  if (event.type === 'runtime_log') return;
  const arr = eventBuffer.get(event.taskId) ?? [];
  arr.push(event);
  if (arr.length > BUFFER_LIMIT) arr.shift();
  eventBuffer.set(event.taskId, arr);
}

export function getBufferedEvents(taskId: string): AgentEvent[] {
  return eventBuffer.get(taskId) ?? [];
}

export function clearBuffer(taskId: string) {
  eventBuffer.delete(taskId);
}

// ============================================================================
// Cancellation signals — in-process. Set when user cancels a task.
// ============================================================================
// TTL: cleared automatically 1h after signalCancellation, чтобы Set не рос бесконечно.
// 1h достаточно, чтобы runner заметил cancel, но не настолько долго, чтобы
// накопились сотни устаревших ID.
// HMR-safe: тоже на globalThis.
const globalForCancelled = globalThis as unknown as { __liaCancelledTasks?: Map<string, number> };
const cancelledTasks: Map<string, number> =
  globalForCancelled.__liaCancelledTasks ?? new Map<string, number>();
globalForCancelled.__liaCancelledTasks = cancelledTasks;
const CANCELLATION_TTL_MS = 60 * 60 * 1000; // 1 час

export function signalCancellation(taskId: string) {
  cancelledTasks.set(taskId, Date.now());
  // Запускаем cleanup только если Map ещё не очищался недавно.
  // Простой подход: при каждом signalCancellation проверяем expired записи.
  const now = Date.now();
  for (const [id, ts] of cancelledTasks) {
    if (now - ts > CANCELLATION_TTL_MS) {
      cancelledTasks.delete(id);
    }
  }
}

export function isCancelled(taskId: string): boolean {
  const ts = cancelledTasks.get(taskId);
  if (!ts) return false;
  // Ленивая очистка при чтении
  if (Date.now() - ts > CANCELLATION_TTL_MS) {
    cancelledTasks.delete(taskId);
    return false;
  }
  return true;
}

export function clearCancellation(taskId: string) {
  cancelledTasks.delete(taskId);
}

// ============================================================================
// Waiting-for-input signals — when a task calls ask_user, it pauses here
// ============================================================================
type WaitingInput = {
  question: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};

// ── HMR-safe storage ──
// В Next.js dev mode webpack hot-reload перезагружает серверные модули, что
// создаёт новый экземпляр Map и теряет все in-flight waiting promises.
// Чтобы пережить HMR, храним Map на globalThis — он переживает reload.
const globalForWaiting = globalThis as unknown as {
  __liaWaitingTasks?: Map<string, WaitingInput>;
};
const waitingTasks: Map<string, WaitingInput> =
  globalForWaiting.__liaWaitingTasks ?? new Map<string, WaitingInput>();
globalForWaiting.__liaWaitingTasks = waitingTasks;

// P-CORE-31 fix: TTL for waiting tasks. Previously, if a task entered
// `waiting_input` and the user never responded (closed the tab, abandoned
// the page), the WaitingInput entry — with its `resolve`/`reject` closures
// — stayed in the Map forever, leaking memory and promises. Now we record
// the timestamp when setWaiting is called, and a 24h TTL expunges stale
// entries (rejecting the promise so the runner's `waitForUserInput` throws
// and the task is marked failed). 24h is generous — even a long workday —
// but bounded.
type WaitingEntry = WaitingInput & { setAt: number };
const waitingTasksTimed = waitingTasks as Map<string, WaitingEntry>;
const WAITING_TTL_MS = 24 * 60 * 60 * 1000;  // 24h

export function setWaiting(taskId: string, w: WaitingInput) {
  waitingTasksTimed.set(taskId, { ...w, setAt: Date.now() });
  // Lazy cleanup: expire any stale entries on each setWaiting call.
  const now = Date.now();
  for (const [id, entry] of waitingTasksTimed) {
    if (now - entry.setAt > WAITING_TTL_MS) {
      waitingTasksTimed.delete(id);
      try {
        entry.reject(new Error('waiting_input timed out (24h inactivity)'));
      } catch { /* reject may throw if already resolved */ }
    }
  }
}

export function resolveWaiting(taskId: string, answer: string): boolean {
  const w = waitingTasks.get(taskId);
  if (!w) return false;
  waitingTasks.delete(taskId);
  w.resolve(answer);
  return true;
}

export function cancelWaiting(taskId: string) {
  const w = waitingTasks.get(taskId);
  if (!w) return;
  waitingTasks.delete(taskId);
  w.reject(new Error('cancelled'));
}

export function isWaiting(taskId: string): boolean {
  return waitingTasks.has(taskId);
}
