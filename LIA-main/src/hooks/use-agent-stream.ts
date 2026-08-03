'use client';

import { useEffect, useRef } from 'react';
import { useChatStore, type AgentTask } from '@/stores/chat-store';
import type { AgentPlanLive, AgentStepLive } from '@/stores/slices/types';
import { mergeAgentSteps } from '@/lib/agent/step-merge';
import { hydrateCreateRuntimeStudio } from '@/lib/agent/runtime/hydrate-client';

type StreamCtx = {
  activeTaskId: string;
  /** Captured at SSE subscribe — survives episode switch clearing agentTasks. */
  taskEpisodeId: string | null;
  updateAgentTaskInList: (id: string, patch: Partial<AgentTask>) => void;
};

function parseEventData(e: Event): Record<string, unknown> | null {
  try {
    return JSON.parse((e as MessageEvent).data);
  } catch {
    return null;
  }
}

/** Fan SSE payload into parts[] reducer (chat bubble source of truth). */
function dispatchParts(ctx: StreamCtx, type: string, data: Record<string, unknown> | null) {
  if (!data) return;
  const store = useChatStore.getState();
  const taskId = ctx.activeTaskId;
  const ts = Number(data.ts ?? Date.now());
  const base = { taskId, ts, eventId: typeof data.eventId === 'string' ? data.eventId : undefined };

  switch (type) {
    case 'task_started':
      store.applyAgentPartEvent(taskId, {
        ...base, type: 'task_started', goal: String(data.goal ?? ''),
      });
      break;
    case 'task_planning':
      store.applyAgentPartEvent(taskId, { ...base, type: 'task_planning' });
      break;
    case 'task_plan_ready':
      if (data.plan && typeof data.plan === 'object') {
        store.applyAgentPartEvent(taskId, {
          ...base,
          type: 'task_plan_ready',
          plan: data.plan as { goal: string; steps: string[]; complexity: string },
        });
      }
      break;
    case 'step_start':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'step_start',
        step: Number(data.step),
        maxSteps: Number(data.maxSteps),
        thought: String(data.thought ?? ''),
      });
      break;
    case 'step_end':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'step_end',
        step: Number(data.step),
        action: String(data.action ?? ''),
        observation: String(data.observation ?? ''),
        thought: String(data.thought ?? ''),
        durationMs: Number(data.durationMs ?? 0),
      });
      break;
    case 'tool_start':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'tool_start',
        step: Number(data.step),
        tool: String(data.tool ?? ''),
        input: data.input,
      });
      break;
    case 'tool_end':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'tool_end',
        step: Number(data.step),
        tool: String(data.tool ?? ''),
        success: Boolean(data.success),
        output: data.output,
      });
      break;
    case 'task_waiting_input':
      store.applyAgentPartEvent(taskId, {
        ...base, type: 'task_waiting_input', question: String(data.question ?? ''),
      });
      break;
    case 'task_synthesizing':
      store.applyAgentPartEvent(taskId, { ...base, type: 'task_synthesizing' });
      break;
    case 'assistant_delta':
      store.applyAgentPartEvent(taskId, {
        ...base, type: 'assistant_delta', text: String(data.text ?? ''),
      });
      break;
    case 'file_changed':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'file_changed',
        step: Number(data.step),
        changeId: String(data.changeId ?? ''),
        path: String(data.path ?? ''),
        tool: (data.tool === 'write_file' ? 'write_file' : 'edit_file'),
        diff: typeof data.diff === 'string' ? data.diff : undefined,
        canUndo: Boolean(data.canUndo),
        pending: Boolean(data.pending),
      });
      break;
    case 'edit_applied':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'edit_applied',
        changeId: String(data.changeId ?? ''),
        path: String(data.path ?? ''),
        tool: (data.tool === 'write_file' ? 'write_file' : 'edit_file'),
        diff: typeof data.diff === 'string' ? data.diff : undefined,
        canUndo: Boolean(data.canUndo),
        step: data.step != null ? Number(data.step) : undefined,
      });
      break;
    case 'edit_rejected':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'edit_rejected',
        changeId: String(data.changeId ?? ''),
        path: String(data.path ?? ''),
        step: data.step != null ? Number(data.step) : undefined,
      });
      break;
    case 'permission_request':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'permission_request',
        requestId: String(data.requestId ?? ''),
        kind: (data.kind as 'shell' | 'network' | 'mcp' | 'write') || 'shell',
        detail: String(data.detail ?? ''),
        payload: data.payload,
      });
      break;
    case 'runtime_log':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'runtime_log',
        stream: (data.stream as 'stdout' | 'stderr' | 'system') || 'system',
        text: String(data.text ?? ''),
      });
      break;
    case 'task_done':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'task_done',
        resultSummary: String(data.resultSummary ?? ''),
        chatMessageId: typeof data.chatMessageId === 'string' ? data.chatMessageId : undefined,
      });
      break;
    case 'task_failed':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'task_failed',
        error: String(data.error ?? 'error'),
        chatMessageId: typeof data.chatMessageId === 'string' ? data.chatMessageId : undefined,
      });
      break;
    case 'task_cancelled':
      store.applyAgentPartEvent(taskId, {
        ...base,
        type: 'task_cancelled',
        chatMessageId: typeof data.chatMessageId === 'string' ? data.chatMessageId : undefined,
      });
      break;
    default:
      break;
  }
}

function applyTerminalStatus(
  ctx: StreamCtx,
  status: 'done' | 'failed' | 'cancelled',
  patch: Partial<AgentTask>,
  opts?: { chatMessageId?: string; chatContent?: string },
) {
  const store = useChatStore.getState();
  store.setActiveTaskStatus(status);
  if (status === 'done') {
    store.setActiveTaskResult(patch.resultSummary ?? '');
  }
  if (status === 'failed') {
    store.setActiveTaskError(patch.error ?? 'unknown error');
  }
  ctx.updateAgentTaskInList(ctx.activeTaskId, { status, ...patch });

  // Prefer parts[] agent-turn message — skip duplicate plain companion bubble.
  const hasPartsTurn = store.messages.some(
    m => m.agentTaskId === ctx.activeTaskId && m.parts && m.parts.length > 0,
  );
  if (hasPartsTurn) return;

  const content = opts?.chatContent?.trim();
  if (content && (status === 'done' || status === 'failed')) {
    const taskEpisodeId = ctx.taskEpisodeId
      ?? store.agentTasks.find(t => t.id === ctx.activeTaskId)?.episodeId
      ?? null;
    if (!taskEpisodeId || store.currentEpisodeId !== taskEpisodeId) {
      return;
    }
    const id = opts?.chatMessageId;
    const already = id
      ? store.messages.some(m => m.id === id)
      : store.messages.some(m => m.role === 'companion' && m.content === content);
    if (!already) {
      store.addMessage({
        id: id ?? crypto.randomUUID(),
        role: 'companion',
        content,
        createdAt: Date.now(),
      });
    }
  }
}

function createSseHandlers(ctx: StreamCtx): Record<string, (e: Event) => void> {
  return {
    task_init: (e) => {
      const task = parseEventData(e);
      if (!task) return;
      if (typeof task.episodeId === 'string') {
        ctx.taskEpisodeId = task.episodeId;
      }
      const store = useChatStore.getState();
      store.setActiveTaskStatus(task.status as AgentTask['status']);
      store.setActiveTaskPlan(null);
      useChatStore.setState({ activeTaskSteps: [] });
      store.setActiveTaskQuestion(null);
      useChatStore.setState({ activeTaskArtifacts: [] });
      useChatStore.setState({ activeTaskFileChanges: [] });
      // Keep design/runtime until hydrate refreshes them (F5 / reconnect).
      if (task.status === 'failed' && task.error) {
        store.setActiveTaskError(String(task.error));
      } else {
        store.setActiveTaskError(null);
      }
      if (task.status === 'done' && task.resultSummary) {
        store.setActiveTaskResult(String(task.resultSummary));
      } else {
        store.setActiveTaskResult(null);
      }
      // Keep fsScope on the task list so workspace UI can show project vs sandbox.
      if (typeof task.id === 'string') {
        ctx.updateAgentTaskInList(task.id, {
          fsScope: task.fsScope != null ? String(task.fsScope) : null,
          ...(typeof task.episodeId === 'string' ? { episodeId: task.episodeId } : {}),
        });
        // Restore design / logs / preview after F5 or new tab (SSE buffer may miss them).
        void hydrateCreateRuntimeStudio(task.id);
      }
    },
    task_started: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'task_started', data ?? { goal: '', ts: Date.now() });
      if (data?.executor === 'claude_code' || data?.executor === 'react') {
        useChatStore.getState().setActiveTaskExecutor(data.executor);
      }
    },
    task_planning: (e) => {
      dispatchParts(ctx, 'task_planning', parseEventData(e));
      useChatStore.getState().setActiveTaskStatus('planning');
    },
    task_plan_ready: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'task_plan_ready', data);
      if (!data?.plan) return;
      useChatStore.getState().setActiveTaskPlan(data.plan as AgentPlanLive);
      useChatStore.getState().setActiveTaskStatus('executing');
      if (data.executor === 'claude_code' || data.executor === 'react') {
        useChatStore.getState().setActiveTaskExecutor(data.executor);
      }
    },
    step_start: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'step_start', data);
      if (!data) return;
      const step = Number(data.step);
      useChatStore.getState().addActiveTaskStep({
        step,
        thought: String(data.thought ?? ''),
        action: '',
        observation: '',
        ts: Number(data.ts),
      });
      const patch: Partial<AgentTask> = {};
      if (Number.isFinite(step) && step > 0) patch.currentStep = step;
      const maxSteps = Number(data.maxSteps);
      if (Number.isFinite(maxSteps) && maxSteps > 0) patch.maxSteps = maxSteps;
      if (Object.keys(patch).length > 0) {
        ctx.updateAgentTaskInList(ctx.activeTaskId, patch);
      }
    },
    step_end: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'step_end', data);
      if (!data) return;
      const store = useChatStore.getState();
      const step = Number(data.step);
      if (!store.activeTaskSteps.some(st => st.step === step)) {
        store.addActiveTaskStep({
          step,
          thought: '',
          action: '',
          observation: '',
          ts: Number(data.ts),
        });
      }
      store.updateActiveTaskStep(step, {
        action: String(data.action ?? ''),
        thought: String(data.thought ?? ''),
        observation: String(data.observation ?? ''),
        durationMs: Number(data.durationMs ?? 0),
      });
      // Keep task list counter in sync with live SSE (panel shows currentStep/maxSteps).
      ctx.updateAgentTaskInList(ctx.activeTaskId, { currentStep: step });
    },
    tool_start: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'tool_start', data);
      if (!data) return;
      const store = useChatStore.getState();
      const step = Number(data.step);
      const tool = String(data.tool ?? '');
      if (!tool || !Number.isFinite(step)) return;

      if (!store.activeTaskSteps.some(st => st.step === step)) {
        store.addActiveTaskStep({
          step,
          thought: '',
          action: tool,
          observation: '',
          tools: [{ name: tool, input: data.input, success: false, output: null }],
          ts: Number(data.ts ?? Date.now()),
        });
        return;
      }

      const existing = store.activeTaskSteps.find(st => st.step === step);
      const prevTools = existing?.tools ?? [];
      store.updateActiveTaskStep(step, {
        action: tool,
        tools: [...prevTools, { name: tool, input: data.input, success: false, output: null }],
      });
    },
    tool_end: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'tool_end', data);
      if (!data) return;
      const store = useChatStore.getState();
      const step = Number(data.step);
      const tool = String(data.tool ?? '');
      if (!tool || !Number.isFinite(step)) return;

      const existing = store.activeTaskSteps.find(st => st.step === step);
      const prevTools = existing?.tools ?? [];
      // Mark the last matching in-flight tool call as finished.
      let marked = false;
      const nextTools = [...prevTools].reverse().map((t) => {
        if (!marked && t.name === tool && t.success === false && t.output == null) {
          marked = true;
          return {
            ...t,
            success: Boolean(data.success),
            output: data.output ?? null,
          };
        }
        return t;
      }).reverse();

      if (!marked) {
        nextTools.push({
          name: tool,
          input: null,
          success: Boolean(data.success),
          output: data.output ?? null,
        });
      }

      const names = nextTools.map(t => t.name);
      const uniqueJoined = names.filter((n, i) => names.indexOf(n) === i).join(' + ');
      store.updateActiveTaskStep(step, {
        action: uniqueJoined || tool,
        tools: nextTools,
      });
    },
    task_waiting_input: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'task_waiting_input', data);
      if (!data?.question) return;
      useChatStore.getState().setActiveTaskStatus('waiting_input');
      useChatStore.getState().setActiveTaskQuestion(String(data.question));
    },
    task_synthesizing: (e) => {
      dispatchParts(ctx, 'task_synthesizing', parseEventData(e) ?? { ts: Date.now() });
      useChatStore.getState().setActiveTaskStatus('synthesizing');
    },
    task_done: (e) => {
      const data = parseEventData(e) ?? {};
      dispatchParts(ctx, 'task_done', data);
      const resultSummary = data.resultSummary != null ? String(data.resultSummary) : '';
      applyTerminalStatus(
        ctx,
        'done',
        { resultSummary },
        {
          chatMessageId: data.chatMessageId ? String(data.chatMessageId) : undefined,
          chatContent: resultSummary,
        },
      );
    },
    task_failed: (e) => {
      const data = parseEventData(e) ?? {};
      dispatchParts(ctx, 'task_failed', data);
      const error = String(data.error ?? 'unknown error');
      applyTerminalStatus(
        ctx,
        'failed',
        { error },
        {
          chatMessageId: data.chatMessageId ? String(data.chatMessageId) : undefined,
          chatContent: `Не удалось выполнить задачу.\n\n${error}`,
        },
      );
    },
    task_cancelled: (e) => {
      const data = parseEventData(e) ?? {};
      dispatchParts(ctx, 'task_cancelled', data);
      applyTerminalStatus(
        ctx,
        'cancelled',
        {},
        {
          chatMessageId: data.chatMessageId ? String(data.chatMessageId) : undefined,
          chatContent: 'Задача отменена.',
        },
      );
    },
    artifact_saved: (e) => {
      const data = parseEventData(e);
      if (!data?.filename || !data?.url) return;
      useChatStore.getState().addActiveTaskArtifact({
        filename: String(data.filename),
        url: String(data.url),
        step: Number(data.step ?? 0),
      });
    },
    file_changed: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'file_changed', data);
      if (!data?.changeId || !data?.path) return;
      useChatStore.getState().addActiveTaskFileChange({
        changeId: String(data.changeId),
        path: String(data.path),
        tool: data.tool === 'write_file' ? 'write_file' : 'edit_file',
        diff: typeof data.diff === 'string' ? data.diff : undefined,
        canUndo: data.canUndo !== false,
        step: Number(data.step ?? 0),
        ts: Number(data.ts ?? Date.now()),
      });
    },
    edit_applied: (e) => {
      dispatchParts(ctx, 'edit_applied', parseEventData(e));
    },
    edit_rejected: (e) => {
      dispatchParts(ctx, 'edit_rejected', parseEventData(e));
    },
    permission_request: (e) => {
      dispatchParts(ctx, 'permission_request', parseEventData(e));
    },
    design_proposed: (e) => {
      const data = parseEventData(e);
      if (!data?.design || typeof data.design !== 'object') return;
      const d = data.design as Record<string, unknown>;
      useChatStore.getState().setActiveTaskDesign({
        name: String(d.name ?? ''),
        kind: String(d.kind ?? ''),
        stack: Array.isArray(d.stack) ? d.stack.map(String) : [],
        tree: Array.isArray(d.tree)
          ? d.tree.map((t: unknown) => {
              const row = t as { path?: string; role?: string };
              return { path: String(row.path ?? ''), role: String(row.role ?? '') };
            })
          : [],
        scripts: (d.scripts && typeof d.scripts === 'object')
          ? (d.scripts as Record<string, string | undefined>)
          : {},
        preview: (d.preview && typeof d.preview === 'object')
          ? {
              type: String((d.preview as { type?: string }).type ?? 'none'),
              port: typeof (d.preview as { port?: number }).port === 'number'
                ? (d.preview as { port: number }).port
                : undefined,
              url: typeof (d.preview as { url?: string }).url === 'string'
                ? (d.preview as { url: string }).url
                : undefined,
            }
          : { type: 'none' },
        entry: typeof d.entry === 'string' ? d.entry : undefined,
        acceptance: String(d.acceptance ?? ''),
        createdBy: 'lia',
      });
    },
    runtime_log: (e) => {
      const data = parseEventData(e);
      dispatchParts(ctx, 'runtime_log', data);
      if (!data?.text) return;
      const stream = data.stream === 'stderr' || data.stream === 'system' ? data.stream : 'stdout';
      useChatStore.getState().addActiveTaskRuntimeLog({
        stream,
        text: String(data.text),
        ts: Number(data.ts ?? Date.now()),
      });
    },
    runtime_status: (e) => {
      const data = parseEventData(e);
      if (!data?.status) return;
      useChatStore.getState().setActiveTaskRuntime({
        status: String(data.status),
        port: data.port != null ? Number(data.port) : null,
        previewUrl: data.previewUrl != null ? String(data.previewUrl) : null,
        pid: data.pid != null ? Number(data.pid) : null,
        restartCount: data.restartCount != null ? Number(data.restartCount) : undefined,
        lastError: data.lastError != null ? String(data.lastError) : null,
        scriptKey: data.scriptKey != null ? String(data.scriptKey) : null,
      });
    },
  };
}

export function useAgentStream() {
  const updateAgentTaskInList = useChatStore(s => s.updateAgentTaskInList);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);
  const activeTaskId = useChatStore(s => s.activeTaskId);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    reconnectCountRef.current = 0;

    if (!activeTaskId) return;

    const listed = useChatStore.getState().agentTasks.find(t => t.id === activeTaskId);
    const ctx: StreamCtx = {
      activeTaskId,
      taskEpisodeId: listed?.episodeId ?? null,
      updateAgentTaskInList,
    };

    const stopPolling = () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };

    const startPolling = () => {
      console.warn('[agent] SSE failed multiple times, falling back to polling');
      stopPolling();
      // UI-H2 fix: previously polling only fetched task.status — steps, plan,
      // children, artifacts, and questions were NEVER loaded in polling mode,
      // so the user saw a spinning ring with no detail. Now we also fetch
      // the /analysis endpoint which returns steps + plan + error analysis.
      // We fetch both endpoints in parallel; if /analysis fails (e.g., older
      // server without the endpoint), we still have task status.
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const [taskRes, analysisRes] = await Promise.all([
            fetch(`/api/agent/${activeTaskId}`).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`/api/agent/${activeTaskId}/analysis`).then(r => r.ok ? r.json() : null).catch(() => null),
          ]);
          if (!taskRes) return;
          const task = taskRes.task as AgentTask | undefined;
          if (!task) return;
          if (task.episodeId) ctx.taskEpisodeId = task.episodeId;

          // Populate steps + plan from /analysis (if available)
          if (analysisRes) {
            const store = useChatStore.getState();
            if (analysisRes.steps && Array.isArray(analysisRes.steps) && analysisRes.steps.length > 0) {
              const persistedSteps: AgentStepLive[] = analysisRes.steps.map((s: Record<string, unknown>) => ({
                step: Number(s.step ?? 0),
                thought: String(s.thought ?? ''),
                action: String(s.action ?? ''),
                observation: String(s.observation ?? ''),
                durationMs: Number(s.durationMs ?? 0),
                tools: Array.isArray(s.tools) ? s.tools as AgentStepLive['tools'] : undefined,
                ts: Number(s.ts ?? Date.now()),
              })).filter((s: AgentStepLive) => Number.isFinite(s.step) && s.step > 0);
              const mergedSteps = mergeAgentSteps(store.activeTaskSteps, persistedSteps);
              if (mergedSteps !== store.activeTaskSteps) {
                useChatStore.setState({ activeTaskSteps: mergedSteps });
              }
            }
            if (analysisRes.plan && !store.activeTaskPlan) {
              store.setActiveTaskPlan(analysisRes.plan);
            }
          }

          // Hydrate artifacts from persisted artifactsJson (SSE may have been missed)
          if (
            Array.isArray(taskRes.artifacts)
            && taskRes.artifacts.length > 0
            && useChatStore.getState().activeTaskArtifacts.length === 0
          ) {
            const store = useChatStore.getState();
            for (const a of taskRes.artifacts as Array<{
              path?: string;
              meta?: { filename?: string; url?: string; step?: number };
            }>) {
              const filename = String(a.meta?.filename ?? a.path ?? '');
              if (!filename) continue;
              const url = String(a.meta?.url ?? `/api/artifacts/${filename}`);
              store.addActiveTaskArtifact({
                filename,
                url,
                step: Number(a.meta?.step ?? 0),
              });
            }
          }

          if (task.status === 'done') {
            applyTerminalStatus(
              ctx,
              'done',
              { resultSummary: task.resultSummary ?? '' },
              { chatContent: task.resultSummary ?? '' },
            );
            stopPolling();
          } else if (task.status === 'failed') {
            const error = task.error ?? 'unknown error';
            applyTerminalStatus(
              ctx,
              'failed',
              { error },
              { chatContent: `Не удалось выполнить задачу.\n\n${error}` },
            );
            stopPolling();
          } else if (task.status === 'cancelled') {
            applyTerminalStatus(
              ctx,
              'cancelled',
              {},
              { chatContent: 'Задача отменена.' },
            );
            stopPolling();
          } else {
            useChatStore.getState().setActiveTaskStatus(task.status);
          }
        } catch (e) {
          console.warn('[agent] polling error:', e);
        }
      }, 2000);
    };

    const es = new EventSource(`/api/agent/${activeTaskId}/stream`);
    eventSourceRef.current = es;

    // Immediate hydrate (don't wait for task_init) — covers done tasks + live preview.
    void hydrateCreateRuntimeStudio(activeTaskId);

    const handlers = createSseHandlers(ctx);
    for (const [type, handler] of Object.entries(handlers)) {
      es.addEventListener(type, (e: Event) => {
        // UI-H2 fix: reset reconnect counter on ANY successful SSE event.
        // Previously a slow drip of errors (one per minute) would accumulate
        // to 5 and trigger permanent polling fallback even though SSE was
        // mostly working. Now any successful event resets the counter.
        reconnectCountRef.current = 0;
        handler(e);
      });
    }

    es.onerror = () => {
      reconnectCountRef.current += 1;
      if (reconnectCountRef.current >= 5 && !pollingIntervalRef.current) {
        es.close();
        eventSourceRef.current = null;
        startPolling();
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      stopPolling();
    };
  }, [activeTaskId, updateAgentTaskInList]);

  useEffect(() => {
    const refresh = async () => {
      try {
        const epId = useChatStore.getState().currentEpisodeId;
        const url = epId ? `/api/agent?episodeId=${epId}` : '/api/agent';
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const tasks = (data.tasks ?? []) as AgentTask[];
        useChatStore.getState().setAgentTasks(tasks);

        const store = useChatStore.getState();
        const activeId = store.activeTaskId;
        if (activeId) {
          const stillThere = tasks.some(t => t.id === activeId);
          if (!stillThere) {
            // Persisted task belongs to another episode or was deleted.
            store.resetActiveTask();
          } else {
            void hydrateCreateRuntimeStudio(activeId);
          }
        } else {
          // After F5 with no persisted active: prefer in-flight task, else latest
          // with sandbox, else latest finished task (so result can re-mirror to chat).
          const running = tasks.find(t =>
            t.status === 'executing' || t.status === 'planning' || t.status === 'waiting_input' || t.status === 'synthesizing',
          );
          const withScope = tasks.find(t => Boolean(t.fsScope));
          const withResult = tasks.find(t =>
            (t.status === 'done' && Boolean(t.resultSummary))
            || t.status === 'failed'
            || t.status === 'cancelled',
          );
          const pick = running ?? withScope ?? withResult ?? null;
          if (pick) store.setActiveTask(pick.id);
        }
      } catch (e) {
        console.error('[useAgentStream] refresh failed:', e);
      }
    };

    const t = setTimeout(() => { refresh(); }, 100);
    return () => clearTimeout(t);
  }, [currentEpisodeId]);
}
