/**
 * Agent store — tracks the active agent task and its live events.
 *
 * Holds the currently-visible agent task (one at a time) and streams its
 * AgentEvents so the chat timeline can render each step inline (Cursor-style).
 */

import { create } from "zustand";
import type { AgentEvent, AgentTask } from "@lia/shared";
import * as api from "../lib/api.js";

interface AgentState {
  /** Currently displayed task (the one bound to the chat). */
  task: AgentTask | null;
  /** Live events for the visible task (accumulates during streaming). */
  events: AgentEvent[];
  /** Whether the task is actively streaming / waiting. */
  isStreaming: boolean;
  /** True while submitting an ask_user answer. */
  submittingAnswer: boolean;
  /** Abort controller for the live stream. */
  _controller: AbortController | null;

  /** Start tracking a task by id: load initial state + open SSE stream. */
  track: (taskId: string) => Promise<void>;
  /** Stop tracking and clear state. */
  clear: () => void;
  /** Cancel the running task (and stop the stream). */
  cancel: () => Promise<void>;
  /** Answer a pending ask_user question. */
  submitAnswer: (answer: string) => Promise<void>;
  /** Apply a pending file change. */
  applyFileChange: (changeId: string) => Promise<void>;
  /** Reject a pending file change. */
  rejectFileChange: (changeId: string) => Promise<void>;
  /** Undo an applied file change. */
  undoFileChange: (changeId: string) => Promise<void>;
  /** Apply all pending. */
  applyAllFileChanges: () => Promise<void>;
  /** Reject all pending. */
  rejectAllFileChanges: () => Promise<void>;
  /** Undo all applied. */
  undoAllFileChanges: () => Promise<void>;
  /** Confirm or reject pending git commit/push. */
  confirmGit: (
    actionId: string,
    decision: "confirm" | "reject",
    message?: string,
  ) => Promise<void>;
}

function isActive(status: AgentTask["status"]): boolean {
  return status === "executing" || status === "pending" || status === "waiting_input";
}

function upsertEvent(events: AgentEvent[], ev: AgentEvent): AgentEvent[] {
  // Avoid duplicating file lifecycle events if SSE + local refresh both fire
  if (
    ev.type === "file_applied" ||
    ev.type === "file_rejected" ||
    ev.type === "file_undone"
  ) {
    const already = events.some(
      (e) =>
        (e.type === "file_applied" || e.type === "file_rejected" || e.type === "file_undone") &&
        "changeId" in e &&
        e.changeId === ev.changeId &&
        e.type === ev.type,
    );
    if (already) return events;
  }
  return [...events, ev];
}

export const useAgentStore = create<AgentState>((set, get) => ({
  task: null,
  events: [],
  isStreaming: false,
  submittingAnswer: false,
  _controller: null,

  track: async (taskId) => {
    get()._controller?.abort();
    get()._controller = null;

    try {
      const task = await api.getAgentTask(taskId);
      set({ task, events: task.events, isStreaming: isActive(task.status) });

      if (isActive(task.status)) {
        const controller = api.streamAgentEvents(taskId, {
          onEvent: (ev) => {
            set((s) => {
              if (ev.type === "done") {
                return { ...s, isStreaming: false };
              }
              const next: Partial<AgentState> = {
                events: upsertEvent(s.events, ev),
              };
              if (ev.type === "ask_user" && s.task) {
                next.task = { ...s.task, status: "waiting_input" };
                next.isStreaming = true;
              }
              if (
                (ev.type === "git_propose_commit" ||
                  ev.type === "git_propose_push" ||
                  ev.type === "deploy_propose" ||
                  ev.type === "ssh_propose") &&
                s.task
              ) {
                next.task = { ...s.task, status: "waiting_input" };
                next.isStreaming = true;
              }
              if (
                (ev.type === "user_answer" ||
                  ev.type === "git_committed" ||
                  ev.type === "git_pushed" ||
                  ev.type === "git_rejected" ||
                  ev.type === "deploy_done" ||
                  ev.type === "deploy_rejected" ||
                  ev.type === "ssh_done" ||
                  ev.type === "ssh_rejected") &&
                s.task
              ) {
                next.task = { ...s.task, status: "executing" };
              }
              return { ...s, ...next };
            });
          },
          onDone: () => {
            set({ isStreaming: false });
            void api.getAgentTask(taskId).then((t) => set({ task: t }));
          },
        });
        set({ _controller: controller });
      }
    } catch (e) {
      console.error("Не удалось отследить агентскую задачу:", e);
    }
  },

  clear: () => {
    get()._controller?.abort();
    set({
      task: null,
      events: [],
      isStreaming: false,
      submittingAnswer: false,
      _controller: null,
    });
  },

  cancel: async () => {
    const task = get().task;
    if (task) {
      try {
        await api.cancelAgentTask(task.id);
      } catch (e) {
        console.error("Не удалось отменить задачу:", e);
      }
    }
    get()._controller?.abort();
    set({ isStreaming: false });
  },

  submitAnswer: async (answer) => {
    const task = get().task;
    if (!task || task.status !== "waiting_input") return;
    set({ submittingAnswer: true });
    try {
      await api.submitAgentInput(task.id, answer);
      set((s) => ({
        submittingAnswer: false,
        task: s.task ? { ...s.task, status: "executing" } : null,
      }));
    } catch (e) {
      set({ submittingAnswer: false });
      console.error("Не удалось отправить ответ агенту:", e);
      throw e;
    }
  },

  applyFileChange: async (changeId) => {
    const task = get().task;
    if (!task) return;
    await api.applyAgentFileChange(task.id, changeId);
    // Event will arrive via SSE poll; optimistic local mark
    set((s) => ({
      events: upsertEvent(s.events, {
        type: "file_applied",
        changeId,
        path:
          s.events.find((e) => e.type === "file_propose" && e.changeId === changeId)?.path ??
          changeId,
        ts: Date.now(),
      }),
    }));
  },

  rejectFileChange: async (changeId) => {
    const task = get().task;
    if (!task) return;
    await api.rejectAgentFileChange(task.id, changeId);
    set((s) => ({
      events: upsertEvent(s.events, {
        type: "file_rejected",
        changeId,
        path:
          s.events.find((e) => e.type === "file_propose" && e.changeId === changeId)?.path ??
          changeId,
        ts: Date.now(),
      }),
    }));
  },

  undoFileChange: async (changeId) => {
    const task = get().task;
    if (!task) return;
    await api.undoAgentFileChange(task.id, changeId);
    set((s) => ({
      events: upsertEvent(s.events, {
        type: "file_undone",
        changeId,
        path:
          s.events.find(
            (e) =>
              (e.type === "file_propose" || e.type === "file_applied") && e.changeId === changeId,
          )?.path ?? changeId,
        ts: Date.now(),
      }),
    }));
  },

  applyAllFileChanges: async () => {
    const task = get().task;
    if (!task) return;
    await api.applyAllAgentFileChanges(task.id);
    // Refresh task events from server so we don't miss IDs
    const refreshed = await api.getAgentTask(task.id);
    set({ task: refreshed, events: refreshed.events });
  },

  rejectAllFileChanges: async () => {
    const task = get().task;
    if (!task) return;
    await api.rejectAllAgentFileChanges(task.id);
    const refreshed = await api.getAgentTask(task.id);
    set({ task: refreshed, events: refreshed.events });
  },

  undoAllFileChanges: async () => {
    const task = get().task;
    if (!task) return;
    await api.undoAllAgentFileChanges(task.id);
    const refreshed = await api.getAgentTask(task.id);
    set({ task: refreshed, events: refreshed.events });
  },

  confirmGit: async (actionId, decision, message) => {
    const task = get().task;
    if (!task) return;
    await api.confirmAgentGit(task.id, { actionId, decision, message });
    set((s) => ({
      task: s.task ? { ...s.task, status: "executing" } : null,
    }));
  },
}));
