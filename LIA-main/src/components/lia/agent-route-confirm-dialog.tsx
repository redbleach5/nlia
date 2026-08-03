'use client';

import { useChatStore, type ChatMessage } from '@/stores/chat-store';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { beginChatStream, endChatStream } from '@/lib/chat/client-stream-control';
import { parseStreamErrorPayload } from '@/lib/chat/stream-error';
import { cueAvatarGesture, cueAvatarLook } from '@/lib/avatar-cues';
import { toast } from 'sonner';
import { hasAgentShellRiskAck } from '@/lib/agent/shell-risk-ack';

/**
 * Ambiguous message while UI mode is Agent — confirm chat vs agent run.
 * Wired from use-chat via pendingAgentRouteConfirm.
 */
export function AgentRouteConfirmDialog() {
  const pending = useChatStore(s => s.pendingAgentRouteConfirm);

  const discardPending = () => {
    const p = useChatStore.getState().pendingAgentRouteConfirm;
    if (!p) return;
    useChatStore.setState((s) => ({
      messages: s.messages.filter(m => m.id !== p.userMessageId),
      pendingAgentRouteConfirm: null,
    }));
  };

  const onAgent = async () => {
    const p = useChatStore.getState().pendingAgentRouteConfirm;
    if (!p) return;
    useChatStore.getState().setPendingAgentRouteConfirm(null);

    const { goal, workspaceMode, userMessageId } = p;

    if (!hasAgentShellRiskAck()) {
      useChatStore.getState().setPendingShellRiskAck({
        goal,
        workspaceMode,
        userMessageId,
        source: 'route',
        forceAgent: true,
      });
      return;
    }

    const episodeId = useChatStore.getState().currentEpisodeId;
    if (!episodeId) return;

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeId,
          goal,
          autoStart: true,
          workspaceMode,
          applyMode: useChatStore.getState().agentApplyMode,
          forceAgent: true,
        }),
      });
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'sandbox_confirm_required') {
          useChatStore.getState().setPendingSandboxConfirm({
            goal,
            workspaceMode,
            userMessageId,
            source: 'chat',
          });
          return;
        }
        throw new Error(err.message || err.error || 'HTTP 409');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const task = data.task;
      if (task) {
        useChatStore.getState().addAgentTask(task);
        useChatStore.getState().setActiveTask(task.id);
        if (data.userMessageId && typeof data.userMessageId === 'string') {
          useChatStore.setState((s) => ({
            messages: s.messages.map(m =>
              m.id === userMessageId ? { ...m, id: data.userMessageId as string } : m,
            ),
          }));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось создать задачу: ${msg}`);
      useChatStore.setState((s) => ({
        messages: s.messages.filter(m => m.id !== userMessageId),
      }));
    }
  };

  const onChat = async () => {
    const p = useChatStore.getState().pendingAgentRouteConfirm;
    if (!p) return;
    useChatStore.getState().setPendingAgentRouteConfirm(null);

    const { goal } = p;
    const episodeId = useChatStore.getState().currentEpisodeId;
    if (!episodeId) return;
    if (useChatStore.getState().isStreaming) return;

    const liaMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'companion',
      content: '',
      streaming: true,
      createdAt: Date.now() + 1,
    };
    useChatStore.getState().addMessage(liaMsg);
    useChatStore.getState().setStreaming(true);
    cueAvatarLook('chat', 4);
    cueAvatarGesture('acknowledge');

    const ac = new AbortController();
    beginChatStream(episodeId, ac);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: goal,
          episodeId,
          mode: 'auto',
        }),
        signal: ac.signal,
      });

      if (res.status === 503) {
        const err = await res.json().catch(() => ({ error: 'Ollama недоступен' }));
        throw new Error(err.error || 'Ollama недоступен');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.type === 'agent_task' && data.taskId) {
          useChatStore.getState().removeMessage(liaMsg.id);
          useChatStore.getState().setMode('agent');
          try {
            const taskRes = await fetch(`/api/agent/${data.taskId}`);
            if (taskRes.ok) {
              const taskData = await taskRes.json();
              if (taskData.task) useChatStore.getState().addAgentTask(taskData.task);
            }
          } catch { /* non-fatal */ }
          useChatStore.getState().setActiveTask(data.taskId);
          return;
        }
      }

      if (!res.body) throw new Error('no response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        useChatStore.getState().updateLastMessage(accumulated);
      }

      const streamErr = parseStreamErrorPayload(accumulated);
      if (streamErr) {
        if (streamErr.partial) {
          useChatStore.getState().updateLastMessage(streamErr.partial);
          useChatStore.getState().finalizeLastMessage();
        } else {
          useChatStore.getState().removeMessage(liaMsg.id);
        }
        toast.error(streamErr.error);
        return;
      }

      useChatStore.getState().updateLastMessage(accumulated);
      useChatStore.getState().finalizeLastMessage();
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        useChatStore.getState().finalizeLastMessage();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        useChatStore.getState().removeMessage(liaMsg.id);
        toast.error(msg);
      }
    } finally {
      endChatStream(ac);
      useChatStore.getState().setStreaming(false);
      cueAvatarLook('user', 1.5);
    }
  };

  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open && useChatStore.getState().pendingAgentRouteConfirm) {
          discardPending();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Агент или диалог?</AlertDialogTitle>
          <AlertDialogDescription>
            Сообщение неоднозначное для агентского цикла. Можно просто ответить
            в диалоге или всё же запустить агента с планом и инструментами.
            Режим «Агент» в селекторе останется выбранным.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={discardPending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
            onClick={(e) => {
              e.preventDefault();
              void onChat();
            }}
          >
            Ответить в диалоге
          </AlertDialogAction>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void onAgent();
            }}
          >
            Запустить агента
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
