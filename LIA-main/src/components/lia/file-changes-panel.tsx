'use client';

// FileChangesPanel — live diffs from agent edit_file / write_file + Undo / Undo all.

import { useState } from 'react';
import { FilePenLine, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { LIA_APP_EVENTS, dispatchLiaAppEvent } from '@/lib/lia-app-events';

export function FileChangesPanel({
  taskId,
  className,
}: {
  taskId: string | null;
  className?: string;
}) {
  const changes = useChatStore(s => s.activeTaskFileChanges);
  const markUndone = useChatStore(s => s.markActiveTaskFileChangeUndone);
  const markUndoneMany = useChatStore(s => s.markActiveTaskFileChangesUndone);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!taskId || changes.length === 0) return null;

  const undoable = changes.filter(c => c.canUndo && !c.undone);

  const undo = async (changeId: string) => {
    setBusyId(changeId);
    setError(null);
    try {
      const res = await fetch(`/api/agent/${taskId}/file-undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'undo failed');
        return;
      }
      markUndone(changeId);
    } catch {
      setError('undo failed');
    } finally {
      setBusyId(null);
    }
  };

  const undoAll = async () => {
    if (undoable.length === 0) return;
    setBusyId('__all__');
    setError(null);
    try {
      const res = await fetch(`/api/agent/${taskId}/file-undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'undo all failed');
        return;
      }
      // Server returns undone paths — mark only those that actually reverted.
      const undonePaths = new Set(
        Array.isArray(data.undone) ? data.undone.filter((p: unknown) => typeof p === 'string') as string[] : [],
      );
      const ids = changes
        .filter(c => undonePaths.has(c.path) && c.canUndo && !c.undone)
        .map(c => c.changeId);
      markUndoneMany(ids);
      if (Array.isArray(data.skipped) && data.skipped.length > 0) {
        setError(`Часть правок не откатить: ${data.skipped.length}`);
      }
    } catch {
      setError('undo all failed');
    } finally {
      setBusyId(null);
    }
  };

  // Newest first
  const ordered = [...changes].reverse();

  return (
    <div className={cn('p-3', className)}>
      <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5 flex items-center gap-1">
        <FilePenLine className="w-3 h-3" />
        <span className="flex-1">Правки файлов</span>
        {undoable.length > 1 && (
          <button
            type="button"
            disabled={busyId !== null}
            onClick={undoAll}
            className="inline-flex items-center gap-0.5 normal-case tracking-normal text-[10px] text-accent hover:underline disabled:opacity-50"
            title="Откатить все правки (с последней)"
          >
            <RotateCcw className={cn('w-3 h-3', busyId === '__all__' && 'animate-spin')} />
            Откатить все
          </button>
        )}
      </div>
      {error && (
        <div className="text-[10px] text-destructive mb-1.5">{error}</div>
      )}
      <div className="space-y-1.5">
        {ordered.map((c) => {
          const open = expanded === c.changeId;
          return (
            <div
              key={c.changeId}
              className={cn(
                'rounded border border-border bg-surface/60 text-[11px]',
                c.undone && 'opacity-50',
              )}
            >
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <button
                  type="button"
                  className="shrink-0 text-text-dim hover:text-foreground"
                  onClick={() => setExpanded(open ? null : c.changeId)}
                  aria-label={open ? 'Свернуть diff' : 'Показать diff'}
                >
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                <button
                  type="button"
                  className="font-mono truncate flex-1 text-left hover:text-accent hover:underline"
                  title={`${c.path} — открыть в дереве workspace`}
                  onClick={() => {
                    dispatchLiaAppEvent(LIA_APP_EVENTS.openWorkspaceFile, { path: c.path });
                  }}
                >
                  {c.path}
                </button>
                <span className="text-[9px] uppercase text-text-dim shrink-0">
                  {c.tool === 'edit_file' ? 'edit' : 'write'}
                  {c.undone ? ' · undone' : ''}
                </span>
                {c.canUndo && !c.undone && (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => undo(c.changeId)}
                    className="inline-flex items-center gap-0.5 text-[10px] text-accent hover:underline disabled:opacity-50 shrink-0"
                    title="Откатить эту правку"
                  >
                    <RotateCcw className={cn('w-3 h-3', busyId === c.changeId && 'animate-spin')} />
                    Отменить
                  </button>
                )}
              </div>
              {open && (
                <pre className="px-2 pb-2 max-h-40 overflow-auto text-[10px] leading-snug font-mono text-muted-foreground whitespace-pre-wrap border-t border-border/60 pt-1.5">
                  {c.diff?.trim() || '(полный rewrite — diff недоступен)'}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
