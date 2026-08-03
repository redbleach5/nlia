/**
 * Agent chat message parts — single source of truth for inline agent UX.
 *
 * Shared (client + server). SSE AgentEvents reduce into parts[]; the chat
 * timeline renders ONLY from parts[] (workbench is a read-only mirror).
 *
 * See docs/AGENTIC-CHAT.md
 */

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error';

/** Which coding backend owns this agent turn. */
export type AgentExecutorKind = 'claude_code' | 'react';

export type MessagePart =
  | {
      id: string;
      type: 'text';
      text: string;
    }
  | {
      id: string;
      type: 'status';
      status: 'planning' | 'executing' | 'waiting_input' | 'synthesizing' | 'done' | 'failed' | 'cancelled';
      detail?: string;
      executor?: AgentExecutorKind;
    }
  | {
      id: string;
      type: 'plan';
      goal: string;
      steps: string[];
      complexity: string;
      targetFiles?: string[];
      executor?: AgentExecutorKind;
    }
  | {
      id: string;
      type: 'tool_call';
      step: number;
      tool: string;
      input?: unknown;
      output?: unknown;
      success?: boolean;
      status: ToolCallStatus;
      /** Auto-collapsed when done (perf for 10+ tools). */
      collapsed: boolean;
      summary?: string;
    }
  | {
      id: string;
      type: 'edit_proposed';
      changeId: string;
      path: string;
      tool: 'edit_file' | 'write_file';
      diff?: string;
      step: number;
    }
  | {
      id: string;
      type: 'edit_applied';
      changeId: string;
      path: string;
      tool: 'edit_file' | 'write_file';
      diff?: string;
      canUndo: boolean;
      step: number;
    }
  | {
      id: string;
      type: 'edit_rejected';
      changeId: string;
      path: string;
      step: number;
    }
  | {
      id: string;
      type: 'ask';
      question: string;
    }
  | {
      id: string;
      type: 'permission_request';
      requestId: string;
      kind: 'shell' | 'network' | 'mcp' | 'write';
      detail: string;
      payload?: unknown;
    }
  | {
      id: string;
      type: 'runtime_log';
      stream: 'stdout' | 'stderr' | 'system';
      text: string;
      collapsed: boolean;
    };

/** Client-facing events that mutate parts (subset + extensions of server AgentEvent). */
export type AgentPartEvent =
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
  | {
      type: 'step_start';
      taskId: string;
      step: number;
      maxSteps: number;
      thought: string;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'step_end';
      taskId: string;
      step: number;
      action: string;
      observation: string;
      thought: string;
      durationMs: number;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'tool_start';
      taskId: string;
      step: number;
      tool: string;
      input: unknown;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'tool_end';
      taskId: string;
      step: number;
      tool: string;
      success: boolean;
      output: unknown;
      ts: number;
      eventId?: string;
    }
  | { type: 'task_waiting_input'; taskId: string; question: string; ts: number; eventId?: string }
  | { type: 'task_synthesizing'; taskId: string; ts: number; eventId?: string }
  | {
      type: 'task_done';
      taskId: string;
      resultSummary: string;
      chatMessageId?: string;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'task_failed';
      taskId: string;
      error: string;
      chatMessageId?: string;
      ts: number;
      eventId?: string;
    }
  | {
      type: 'task_cancelled';
      taskId: string;
      chatMessageId?: string;
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
      type: 'file_changed';
      taskId: string;
      step: number;
      changeId: string;
      path: string;
      tool: 'edit_file' | 'write_file';
      diff?: string;
      canUndo: boolean;
      /** When true, change is pending Apply (ask mode). */
      pending?: boolean;
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
      type: 'runtime_log';
      taskId: string;
      stream: 'stdout' | 'stderr' | 'system';
      text: string;
      ts: number;
      eventId?: string;
    };

export type PartsReduceState = {
  parts: MessagePart[];
  /** Seen event ids for idempotent replay / reconnect. */
  seenEventIds: Set<string>;
  metrics: AgentTurnMetrics;
};

export type AgentTurnMetrics = {
  startedAt: number | null;
  firstTextAt: number | null;
  toolStarts: number;
  toolSuccesses: number;
  toolFailures: number;
  applyAccepts: number;
  applyRejects: number;
};

export const MAX_EXPANDED_DIFFS = 3;
export const DIFF_PREVIEW_CHARS = 4000;

function eid(event: AgentPartEvent): string {
  if (event.eventId) return event.eventId;
  // Stable-enough fallback for buffered events without explicit id
  const base = `${event.type}:${event.taskId}:${event.ts}`;
  if ('step' in event && typeof (event as { step?: number }).step === 'number') {
    return `${base}:${(event as { step: number }).step}:${'tool' in event ? String((event as { tool?: string }).tool ?? '') : ''}`;
  }
  if ('changeId' in event) return `${base}:${(event as { changeId: string }).changeId}`;
  if ('requestId' in event) return `${base}:${(event as { requestId: string }).requestId}`;
  return base;
}

function summarizeToolOutput(output: unknown, success: boolean): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const oneLine = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  return success ? (oneLine || 'ok') : (oneLine || 'error');
}

function ensureTextPart(parts: MessagePart[]): { parts: MessagePart[]; textId: string } {
  const last = parts[parts.length - 1];
  if (last?.type === 'text') return { parts, textId: last.id };
  const textId = `text-${parts.length}`;
  return { parts: [...parts, { id: textId, type: 'text', text: '' }], textId };
}

function upsertStatus(
  parts: MessagePart[],
  status: Extract<MessagePart, { type: 'status' }>['status'],
  detail?: string,
  executor?: AgentExecutorKind,
): MessagePart[] {
  const idx = parts.findIndex(p => p.type === 'status');
  const prev = idx >= 0 && parts[idx].type === 'status' ? parts[idx] : null;
  const part: MessagePart = {
    id: 'status',
    type: 'status',
    status,
    detail,
    executor: executor ?? (prev && prev.type === 'status' ? prev.executor : undefined),
  };
  if (idx >= 0) {
    const next = parts.slice();
    next[idx] = part;
    return next;
  }
  return [part, ...parts.filter(p => p.type !== 'status')];
}

/**
 * Pure reducer: AgentPartEvent → next parts state.
 * Idempotent on eventId (or derived key).
 */
export function reduceAgentParts(
  state: PartsReduceState,
  event: AgentPartEvent,
): PartsReduceState {
  const id = eid(event);
  if (state.seenEventIds.has(id)) return state;

  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(id);
  let parts = state.parts;
  const metrics: AgentTurnMetrics = { ...state.metrics };

  if (metrics.startedAt == null && event.type === 'task_started') {
    metrics.startedAt = event.ts;
  }

  switch (event.type) {
    case 'task_started':
      parts = upsertStatus(
        parts,
        'executing',
        event.goal.slice(0, 120),
        event.executor,
      );
      break;

    case 'task_planning':
      parts = upsertStatus(parts, 'planning');
      break;

    case 'task_plan_ready':
      parts = upsertStatus(parts, 'executing', undefined, event.executor);
      parts = [
        ...parts.filter(p => p.type !== 'plan'),
        {
          id: 'plan',
          type: 'plan',
          goal: event.plan.goal,
          steps: event.plan.steps,
          complexity: event.plan.complexity,
          targetFiles: event.plan.targetFiles,
          executor: event.executor,
        },
      ];
      break;

    case 'step_start': {
      parts = upsertStatus(parts, 'executing');
      if (event.thought?.trim()) {
        const ens = ensureTextPart(parts);
        parts = ens.parts.map(p =>
          p.id === ens.textId && p.type === 'text'
            ? { ...p, text: p.text ? `${p.text}\n${event.thought}` : event.thought }
            : p,
        );
        if (metrics.firstTextAt == null) metrics.firstTextAt = event.ts;
      }
      break;
    }

    case 'assistant_delta': {
      const ens = ensureTextPart(parts);
      parts = ens.parts.map(p =>
        p.id === ens.textId && p.type === 'text'
          ? { ...p, text: p.text + event.text }
          : p,
      );
      if (metrics.firstTextAt == null && event.text) metrics.firstTextAt = event.ts;
      break;
    }

    case 'tool_start': {
      metrics.toolStarts += 1;
      const toolId = `tool-${event.step}-${event.tool}`;
      const existing = parts.findIndex(p => p.id === toolId);
      const part: MessagePart = {
        id: toolId,
        type: 'tool_call',
        step: event.step,
        tool: event.tool,
        input: event.input,
        status: 'running',
        collapsed: false,
      };
      if (existing >= 0) {
        const next = parts.slice();
        next[existing] = part;
        parts = next;
      } else {
        parts = [...parts, part];
      }
      break;
    }

    case 'tool_end': {
      if (event.success) metrics.toolSuccesses += 1;
      else metrics.toolFailures += 1;
      const toolId = `tool-${event.step}-${event.tool}`;
      parts = parts.map(p => {
        if (p.id !== toolId || p.type !== 'tool_call') return p;
        return {
          ...p,
          status: event.success ? 'done' as const : 'error' as const,
          success: event.success,
          output: event.output,
          collapsed: true,
          summary: summarizeToolOutput(event.output, event.success),
        };
      });
      break;
    }

    case 'file_changed': {
      if (event.pending) {
        parts = [
          ...parts.filter(p => !(p.type === 'edit_proposed' && p.changeId === event.changeId)),
          {
            id: `edit-prop-${event.changeId}`,
            type: 'edit_proposed',
            changeId: event.changeId,
            path: event.path,
            tool: event.tool,
            diff: event.diff,
            step: event.step,
          },
        ];
      } else {
        parts = [
          ...parts.filter(p =>
            !(p.type === 'edit_proposed' && p.changeId === event.changeId)
            && !(p.type === 'edit_applied' && p.changeId === event.changeId),
          ),
          {
            id: `edit-app-${event.changeId}`,
            type: 'edit_applied',
            changeId: event.changeId,
            path: event.path,
            tool: event.tool,
            diff: event.diff,
            canUndo: event.canUndo,
            step: event.step,
          },
        ];
      }
      break;
    }

    case 'edit_applied': {
      metrics.applyAccepts += 1;
      parts = [
        ...parts.filter(p =>
          !(p.type === 'edit_proposed' && p.changeId === event.changeId)
          && !(p.type === 'edit_applied' && p.changeId === event.changeId),
        ),
        {
          id: `edit-app-${event.changeId}`,
          type: 'edit_applied',
          changeId: event.changeId,
          path: event.path,
          tool: event.tool,
          diff: event.diff,
          canUndo: event.canUndo,
          step: event.step ?? 0,
        },
      ];
      break;
    }

    case 'edit_rejected': {
      metrics.applyRejects += 1;
      parts = [
        ...parts.filter(p =>
          !(p.type === 'edit_proposed' && p.changeId === event.changeId),
        ),
        {
          id: `edit-rej-${event.changeId}`,
          type: 'edit_rejected',
          changeId: event.changeId,
          path: event.path,
          step: event.step ?? 0,
        },
      ];
      break;
    }

    case 'task_waiting_input':
      parts = upsertStatus(parts, 'waiting_input', event.question.slice(0, 200));
      parts = [
        ...parts.filter(p => p.type !== 'ask'),
        { id: 'ask', type: 'ask', question: event.question },
      ];
      break;

    case 'permission_request':
      parts = [
        ...parts.filter(p => !(p.type === 'permission_request' && p.requestId === event.requestId)),
        {
          id: `perm-${event.requestId}`,
          type: 'permission_request',
          requestId: event.requestId,
          kind: event.kind,
          detail: event.detail,
          payload: event.payload,
        },
      ];
      break;

    case 'task_synthesizing':
      parts = upsertStatus(parts, 'synthesizing');
      break;

    case 'task_done': {
      parts = upsertStatus(parts, 'done');
      if (event.resultSummary?.trim()) {
        const ens = ensureTextPart(parts);
        parts = ens.parts.map(p =>
          p.id === ens.textId && p.type === 'text'
            ? {
                ...p,
                text: p.text.trim()
                  ? (p.text.includes(event.resultSummary) ? p.text : `${p.text}\n\n${event.resultSummary}`)
                  : event.resultSummary,
              }
            : p,
        );
        if (metrics.firstTextAt == null) metrics.firstTextAt = event.ts;
      }
      break;
    }

    case 'task_failed':
      parts = upsertStatus(parts, 'failed', event.error.slice(0, 300));
      break;

    case 'task_cancelled':
      parts = upsertStatus(parts, 'cancelled');
      break;

    case 'runtime_log': {
      const logId = `rlog-${event.ts}`;
      parts = [
        ...parts,
        {
          id: logId,
          type: 'runtime_log',
          stream: event.stream,
          text: event.text.slice(0, 2000),
          collapsed: true,
        },
      ];
      break;
    }

    case 'step_end':
      // Thought already handled on step_start; observation is in tools.
      break;

    default:
      break;
  }

  return { parts, seenEventIds, metrics };
}

export function createEmptyPartsState(startedAt: number | null = null): PartsReduceState {
  return {
    parts: [],
    seenEventIds: new Set(),
    metrics: {
      startedAt,
      firstTextAt: null,
      toolStarts: 0,
      toolSuccesses: 0,
      toolFailures: 0,
      applyAccepts: 0,
      applyRejects: 0,
    },
  };
}

/** Replay buffered events into a fresh parts state (SSE reconnect). */
export function replayAgentPartEvents(events: AgentPartEvent[]): PartsReduceState {
  let state = createEmptyPartsState();
  for (const ev of events) {
    state = reduceAgentParts(state, ev);
  }
  return state;
}

/** Collapse text from parts for legacy content field / DB preview. */
export function partsToPlainText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) chunks.push(p.text.trim());
    if (p.type === 'ask') chunks.push(`❓ ${p.question}`);
    if (p.type === 'status' && p.status === 'failed' && p.detail) chunks.push(`⚠️ ${p.detail}`);
  }
  return chunks.join('\n\n');
}

/** How many edit diffs are currently "expanded" candidates (proposed + applied with diff). */
export function countExpandableDiffs(parts: MessagePart[]): number {
  return parts.filter(p =>
    (p.type === 'edit_proposed' || p.type === 'edit_applied') && !!p.diff,
  ).length;
}
