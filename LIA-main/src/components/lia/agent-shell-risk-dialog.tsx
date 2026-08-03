'use client';

import { useChatStore, type PendingShellRiskAck } from '@/stores/chat-store';
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
import { setAgentShellRiskAck } from '@/lib/agent/shell-risk-ack';
import { toast } from 'sonner';

async function createAgentFromPending(p: PendingShellRiskAck): Promise<void> {
  const episodeId = useChatStore.getState().currentEpisodeId;
  if (!episodeId) return;

  const { goal, workspaceMode, userMessageId, template, confirmSandbox, forceAgent } = p;
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      episodeId,
      goal,
      autoStart: true,
      workspaceMode,
      applyMode: useChatStore.getState().agentApplyMode,
      ...(forceAgent ? { forceAgent: true } : {}),
      ...(confirmSandbox ? { confirmSandbox: true } : {}),
      ...(template ? { template } : {}),
    }),
  });

  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    if (err.error === 'sandbox_confirm_required') {
      useChatStore.getState().setPendingSandboxConfirm({
        goal,
        workspaceMode,
        userMessageId,
        source: p.source === 'panel' ? 'panel' : 'chat',
        ...(template ? { template } : {}),
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
}

/**
 * One-time ack that the agent may run shell / install packages.
 * Wired via pendingShellRiskAck from use-chat / use-agent / confirm dialogs.
 */
export function AgentShellRiskDialog() {
  const pending = useChatStore(s => s.pendingShellRiskAck);

  const discardPending = () => {
    const p = useChatStore.getState().pendingShellRiskAck;
    if (!p) return;
    useChatStore.setState((s) => ({
      messages: s.messages.filter(m => m.id !== p.userMessageId),
      pendingShellRiskAck: null,
    }));
  };

  const onConfirm = async () => {
    const p = useChatStore.getState().pendingShellRiskAck;
    if (!p) return;
    useChatStore.getState().setPendingShellRiskAck(null);
    setAgentShellRiskAck();

    try {
      await createAgentFromPending(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось создать задачу: ${msg}`);
      useChatStore.setState((s) => ({
        messages: s.messages.filter(m => m.id !== p.userMessageId),
      }));
    }
  };

  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open && useChatStore.getState().pendingShellRiskAck) {
          discardPending();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Агент и команды на машине</AlertDialogTitle>
          <AlertDialogDescription>
            Агент может выполнять команды в рабочей папке (тесты, git, скрипты)
            и предлагать установку пакетов. Установка пакетов всегда спросит
            подтверждение; остальное зависит от режима Ask/Auto.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={discardPending}>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>
            Понятно
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
