'use client';

import { useChatStore } from '@/stores/chat-store';
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
import { toast } from 'sonner';
import { hasAgentShellRiskAck } from '@/lib/agent/shell-risk-ack';

/**
 * Confirm Edit→sandbox when no project/KB workspace is bound.
 * Wired from use-chat / use-agent via pendingSandboxConfirm.
 */
export function SandboxConfirmDialog() {
  const pending = useChatStore(s => s.pendingSandboxConfirm);

  const discardPending = () => {
    const p = useChatStore.getState().pendingSandboxConfirm;
    if (!p) return;
    useChatStore.setState((s) => ({
      messages: s.messages.filter(m => m.id !== p.userMessageId),
      pendingSandboxConfirm: null,
    }));
  };

  const onConfirm = async () => {
    const p = useChatStore.getState().pendingSandboxConfirm;
    if (!p) return;
    // Clear first so onOpenChange(false) does not treat this as cancel.
    useChatStore.getState().setPendingSandboxConfirm(null);

    const { goal, workspaceMode, userMessageId, template } = p;

    if (!hasAgentShellRiskAck()) {
      useChatStore.getState().setPendingShellRiskAck({
        goal,
        workspaceMode,
        userMessageId,
        source: 'sandbox',
        template,
        confirmSandbox: true,
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
          confirmSandbox: true,
          forceAgent: true,
          ...(template ? { template } : {}),
        }),
      });
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

  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open && useChatStore.getState().pendingSandboxConfirm) {
          discardPending();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Запись в черновик?</AlertDialogTitle>
          <AlertDialogDescription>
            Режим Правка без привязанной папки или источника KB — агент будет
            писать в пустой sandbox, а не в ваш проект. Выбери папку в шапке
            чата или подтверди черновик.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={discardPending}>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>
            Продолжить в черновике
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
