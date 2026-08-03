'use client';

import { useCallback } from 'react';
import { useChatStore, type AgentTask } from '@/stores/chat-store';
import { hasAgentShellRiskAck } from '@/lib/agent/shell-risk-ack';
import { toast } from 'sonner';

export function useAgent() {
  const setAgentTasks = useChatStore(s => s.setAgentTasks);
  const addAgentTask = useChatStore(s => s.addAgentTask);
  const updateAgentTaskInList = useChatStore(s => s.updateAgentTaskInList);

  const refresh = useCallback(async () => {
    try {
      const state = useChatStore.getState();
      const epId = state.currentEpisodeId;
      const url = epId ? `/api/agent?episodeId=${epId}` : '/api/agent';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setAgentTasks((data.tasks ?? []) as AgentTask[]);
    } catch (e) {
      console.error('[useAgent] refresh failed:', e);
    }
  }, [setAgentTasks]);

  const create = useCallback(async (params: {
    goal: string;
    toolsWhitelist?: string[];
    fsScope?: string;
    maxSteps?: number;
    maxDurationSec?: number;
    template?: 'general' | 'researcher' | 'coder';
    workspaceMode?: 'auto' | 'read' | 'explore' | 'edit';
    confirmSandbox?: boolean;
  }): Promise<AgentTask | null> => {
    const state = useChatStore.getState();
    if (!state.currentEpisodeId) return null;
    try {
      const workspaceMode = params.workspaceMode ?? state.agentWorkspaceMode;

      if (!hasAgentShellRiskAck()) {
        const userMsgId = crypto.randomUUID();
        useChatStore.getState().addMessage({
          id: userMsgId,
          role: 'user',
          content: params.goal,
          createdAt: Date.now(),
        });
        state.setPendingShellRiskAck({
          goal: params.goal,
          workspaceMode,
          userMessageId: userMsgId,
          source: 'panel',
          template: params.template,
          confirmSandbox: params.confirmSandbox,
          forceAgent: true,
        });
        return null;
      }

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          workspaceMode,
          applyMode: state.agentApplyMode,
          episodeId: state.currentEpisodeId,
          // Explicit create from agent UI — skip intent gate.
          forceAgent: true,
        }),
      });
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'sandbox_confirm_required') {
          const userMsgId = crypto.randomUUID();
          useChatStore.getState().addMessage({
            id: userMsgId,
            role: 'user',
            content: params.goal,
            createdAt: Date.now(),
          });
          state.setPendingSandboxConfirm({
            goal: params.goal,
            workspaceMode,
            userMessageId: userMsgId,
            source: 'panel',
            template: params.template,
          });
          return null;
        }
        toast.error(err.message || err.error || 'Нужно подтверждение sandbox');
        return null;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || `HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!data.task) {
        toast.error(data.message || 'Не удалось создать задачу');
        return null;
      }
      const task = data.task as AgentTask;
      addAgentTask(task);
      useChatStore.getState().setActiveTask(task.id);
      return task;
    } catch (e) {
      console.error('[useAgent] create failed:', e);
      return null;
    }
  }, [addAgentTask]);

  const cancel = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/agent/${id}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || `Не удалось отменить (HTTP ${res.status})`);
        return false;
      }
      const status = (data.task?.status as AgentTask['status'] | undefined) ?? 'cancelled';
      updateAgentTaskInList(id, { status });
      const store = useChatStore.getState();
      if (store.activeTaskId === id) {
        store.setActiveTaskStatus(status);
        store.setActiveTaskQuestion(null);
      }
      return true;
    } catch (e) {
      console.error('[useAgent] cancel failed:', e);
      toast.error(`Не удалось отменить: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [updateAgentTaskInList]);

  const start = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/agent/${id}/start`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || `Не удалось запустить (HTTP ${res.status})`);
        return false;
      }
      const status = (data.task?.status as AgentTask['status'] | undefined) ?? 'planning';
      updateAgentTaskInList(id, { status, error: null });
      const store = useChatStore.getState();
      if (store.activeTaskId === id) {
        store.setActiveTaskStatus(status);
        store.setActiveTaskError(null);
      }
      return true;
    } catch (e) {
      console.error('[useAgent] start failed:', e);
      toast.error(`Не удалось запустить: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [updateAgentTaskInList]);

  const provideInput = useCallback(async (id: string, answer: string): Promise<boolean> => {
    // UI-C7 fix: return true on success, false on any failure. Callers
    // (e.g., AgentWaitingPrompt) can avoid clearing the user's typed answer
    // when the request failed — they can retry or edit instead of losing it.
    try {
      const res = await fetch(`/api/agent/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));

        if (res.status === 409) {
          toast.error('Сессия ожидания потеряна. Задача помечена как failed — перезапусти её.');
          useChatStore.getState().setActiveTaskStatus('failed');
          useChatStore.getState().setActiveTaskError(err.message || 'waiting state lost');
          useChatStore.getState().setActiveTaskQuestion(null);
          updateAgentTaskInList(id, {
            status: 'failed',
            error: err.message || 'waiting state lost',
          });
        } else if (res.status === 400 && err.currentStatus) {
          toast.error(`Задача уже в статусе "${err.currentStatus}". Ответ не нужен.`);
          useChatStore.getState().setActiveTaskQuestion(null);
        } else {
          toast.error(`Не удалось отправить ответ: ${err.error || res.status}`);
          console.error('[useAgent] input failed:', err);
        }
        return false;
      }

      useChatStore.getState().setActiveTaskQuestion(null);
      return true;
    } catch (e) {
      console.error('[useAgent] input failed:', e);
      toast.error(`Сетевая ошибка: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [updateAgentTaskInList]);

  const selectTask = useCallback((id: string) => {
    useChatStore.getState().setActiveTask(id);
    refresh();
  }, [refresh]);

  return { refresh, create, start, cancel, provideInput, selectTask };
}
