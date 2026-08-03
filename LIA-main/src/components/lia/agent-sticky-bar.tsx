'use client';

import { useEffect, useState } from 'react';
import { Shield, Zap, RotateCcw } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { isAgentBusyStatus, agentWorkbenchSummary } from '@/lib/agent/task-status-ui';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const STALE_PROGRESS_MS = 5 * 60 * 1000;

/**
 * Sticky mini-bar over composer while an agent turn is busy:
 * status + Apply mode + rollback. Stop lives in ChatInput (Esc).
 */
export function AgentStickyBar() {
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const status = useChatStore(s => s.activeTaskStatus);
  const plan = useChatStore(s => s.activeTaskPlan);
  const steps = useChatStore(s => s.activeTaskSteps);
  const fileChanges = useChatStore(s => s.activeTaskFileChanges);
  const applyMode = useChatStore(s => s.agentApplyMode);
  const setApplyMode = useChatStore(s => s.setAgentApplyMode);
  const executor = useChatStore(s => s.activeTaskExecutor);
  const markUndoneMany = useChatStore(s => s.markActiveTaskFileChangesUndone);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [staleProgress, setStaleProgress] = useState(false);

  const busy = isAgentBusyStatus(status);

  // Soft hint when no new steps for ≥5 min (watchdog is still 30 min).
  // Skip waiting_input — progress is blocked on the user, not a hang.
  useEffect(() => {
    if (!busy || !activeTaskId || status === 'waiting_input') {
      setStaleProgress(false);
      return;
    }
    const lastTs = steps.reduce((max, s) => Math.max(max, s.ts || 0), 0);
    const startedAt = lastTs > 0 ? lastTs : Date.now();
    const check = () => {
      setStaleProgress(Date.now() - startedAt >= STALE_PROGRESS_MS);
    };
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [busy, activeTaskId, status, steps]);

  if (!activeTaskId || !busy) return null;

  const isClaudeCode = executor === 'claude_code';
  const undoable = fileChanges.filter(c => c.canUndo && !c.undone);
  const summary = isClaudeCode
    ? (plan?.goal ? plan.goal.slice(0, 80) : 'Claude Code…')
    : (agentWorkbenchSummary({
      status,
      busy,
      stepCount: steps.length,
      editCount: fileChanges.length,
      undoableCount: undoable.length,
      runtimeHealthy: false,
      designKind: undefined,
    }) || (plan?.goal ? plan.goal.slice(0, 80) : 'Агент работает…'));

  const toggleApply = () => {
    const next = applyMode === 'ask' ? 'auto' : 'ask';
    setApplyMode(next);
    toast.message(next === 'auto' ? 'Авто-применение правок' : 'Спрашивать перед записью');
  };

  const rollback = async () => {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    try {
      const res = await fetch(`/api/agent/${activeTaskId}/rollback`, { method: 'POST' });
      if (res.ok) {
        markUndoneMany(fileChanges.map(c => c.changeId));
        toast.message('Ход откатан');
      } else {
        toast.error('Не удалось откатить ход');
      }
    } catch {
      toast.error('Не удалось откатить ход');
    } finally {
      setRollbackBusy(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-surface/90 backdrop-blur-sm px-5 py-1.5 shrink-0">
      <div className="lia-chat-rail flex items-center gap-2 min-w-0">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            staleProgress ? 'bg-amber-400' : 'bg-accent animate-pulse',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'text-[11px] truncate flex-1 min-w-0',
            staleProgress ? 'text-amber-200/90' : 'text-text-muted',
          )}
          title={staleProgress ? 'Долго без прогресса — можно остановить (Esc)' : summary}
        >
          {staleProgress ? 'Долго без прогресса — можно остановить (Esc)' : summary}
        </span>
        {!isClaudeCode && (
        <button
          type="button"
          onClick={toggleApply}
          title={applyMode === 'ask' ? 'Спрашивать перед записью (Ctrl+Shift+A)' : 'Авто-применение (Ctrl+Shift+A)'}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] shrink-0',
            applyMode === 'ask'
              ? 'text-amber-200/90 hover:bg-amber-500/10'
              : 'text-emerald-300/90 hover:bg-emerald-500/10',
          )}
        >
          {applyMode === 'ask' ? <Shield className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
          {applyMode === 'ask' ? 'Ask' : 'Auto'}
        </button>
        )}
        {isClaudeCode && (
          <span className="text-[10px] text-text-muted/80 shrink-0 px-1" title="Запись через Claude Code (auto)">
            CC
          </span>
        )}
        {undoable.length > 0 && (
          <button
            type="button"
            disabled={rollbackBusy}
            onClick={() => void rollback()}
            title="Откатить ход"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-rose-300/90 hover:bg-rose-500/10 shrink-0 disabled:opacity-50"
          >
            <RotateCcw className={cn('w-3 h-3', rollbackBusy && 'animate-spin')} />
            Откатить
          </button>
        )}
      </div>
    </div>
  );
}
