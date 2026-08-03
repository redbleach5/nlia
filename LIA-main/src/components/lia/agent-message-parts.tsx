'use client';

import { memo, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { MessagePart } from '@/lib/agent/message-parts';
import { DIFF_PREVIEW_CHARS, MAX_EXPANDED_DIFFS } from '@/lib/agent/message-parts';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './markdown-renderer';
import { useChatStore } from '@/stores/chat-store';
import { useAgent } from '@/hooks/use-agent';
import { Loader2 } from 'lucide-react';

const WINDOW_THRESHOLD = 40;
const WINDOW_TAIL = 28;

const KIND_LABEL: Record<string, string> = {
  shell: 'команда',
  network: 'сеть',
  mcp: 'MCP',
  write: 'запись',
};

const EDIT_STATUS: Record<string, string> = {
  edit_proposed: 'ожидает',
  edit_applied: 'записано',
  edit_rejected: 'отклонено',
};

/**
 * Renders agent-turn parts[] — sole visual source for agent bubbles.
 * Completed tools are collapsed; at most MAX_EXPANDED_DIFFS diffs show full preview.
 */
export const AgentMessageParts = memo(function AgentMessageParts({
  parts,
  taskId,
  streaming = false,
}: {
  parts: MessagePart[];
  taskId?: string;
  streaming?: boolean;
}) {
  const applyMode = useChatStore(s => s.agentApplyMode);
  const patchParts = useChatStore(s => s.patchAgentTurnParts);
  const { provideInput } = useAgent();
  const [showEarly, setShowEarly] = useState(false);

  const pendingEdits = useMemo(
    () => parts.filter(p => p.type === 'edit_proposed'),
    [parts],
  );

  const diffSlots = useMemo(() => {
    const editable = parts.filter(
      p => (p.type === 'edit_proposed' || p.type === 'edit_applied') && p.diff,
    );
    return new Set(editable.slice(-MAX_EXPANDED_DIFFS).map(p => p.id));
  }, [parts]);

  const lastTextId = useMemo(() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === 'text') return parts[i].id;
    }
    return null;
  }, [parts]);

  const visibleParts = useMemo(() => {
    if (showEarly || parts.length <= WINDOW_THRESHOLD) return parts;
    return parts.slice(-WINDOW_TAIL);
  }, [parts, showEarly]);

  const hiddenCount = parts.length - visibleParts.length;

  const applyAllPending = useCallback(async () => {
    if (!taskId || pendingEdits.length === 0) return;
    const changeIds = pendingEdits.map(p => p.changeId);
    patchParts(taskId, prev =>
      prev.map(p =>
        p.type === 'edit_proposed' && changeIds.includes(p.changeId)
          ? {
              id: `edit-app-${p.changeId}`,
              type: 'edit_applied' as const,
              changeId: p.changeId,
              path: p.path,
              tool: p.tool,
              diff: p.diff,
              canUndo: true,
              step: p.step,
            }
          : p,
      ),
    );
    try {
      await fetch(`/api/agent/${taskId}/file-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* SSE will reconcile */
    }
  }, [taskId, pendingEdits, patchParts]);

  return (
    <div className="flex flex-col gap-2 text-sm">
      {pendingEdits.length > 0 && applyMode === 'ask' && taskId && (
        <div className="sticky top-0 z-[1] flex items-center gap-2 rounded border border-accent/30 bg-surface/95 backdrop-blur-sm px-2 py-1.5 text-[11px]">
          <span className="text-text-muted flex-1 min-w-0">
            {pendingEdits.length === 1
              ? '1 файл ждёт Apply'
              : `${pendingEdits.length} файлов ждут Apply`}
          </span>
          <button
            type="button"
            className="text-emerald-400 underline shrink-0"
            onClick={() => void applyAllPending()}
          >
            Применить все
          </button>
        </div>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          className="text-[11px] text-sky-400/90 underline self-start"
          onClick={() => setShowEarly(true)}
        >
          Показать ранние {hiddenCount} шагов
        </button>
      )}

      {visibleParts.map(p => {
        switch (p.type) {
          case 'status':
            return (
              <div key={p.id} className="text-[11px] text-text-dim tracking-wide">
                {statusLabel(p.status)}
                {p.detail ? ` — ${p.detail}` : ''}
              </div>
            );
          case 'plan':
            return (
              <div key={p.id} className="rounded border border-border/40 bg-surface/40 px-2 py-1 text-[12px]">
                <div className="text-[10px] text-text-dim mb-0.5">План · {p.complexity}</div>
                <ol className="list-decimal pl-3.5 space-y-0.5 text-text-muted leading-snug">
                  {p.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
                {p.targetFiles && p.targetFiles.length > 0 && (
                  <div className="mt-1 text-[10px] text-text-dim/90 font-mono break-all">
                    Файлы: {p.targetFiles.slice(0, 12).join(' · ')}
                    {p.targetFiles.length > 12 ? ` +${p.targetFiles.length - 12}` : ''}
                  </div>
                )}
              </div>
            );
          case 'text':
            return p.text || (streaming && p.id === lastTextId) ? (
              <div
                key={p.id}
                className={cn(streaming && p.id === lastTextId && 'lia-cursor')}
              >
                {p.text ? <MarkdownRenderer content={p.text} /> : (
                  <span className="text-text-dim italic text-[12px]">пишу…</span>
                )}
              </div>
            ) : null;
          case 'tool_call':
            return <ToolCallCard key={p.id} part={p} />;
          case 'edit_proposed':
          case 'edit_applied':
          case 'edit_rejected':
            return (
              <EditCard
                key={p.id}
                part={p}
                taskId={taskId}
                expanded={diffSlots.has(p.id)}
                applyMode={applyMode}
              />
            );
          case 'ask':
            return (
              <AskCard
                key={p.id}
                part={p}
                taskId={taskId}
                provideInput={provideInput}
                onAnswered={() => {
                  if (!taskId) return;
                  patchParts(taskId, prev => prev.filter(x => x.type !== 'ask'));
                }}
              />
            );
          case 'permission_request':
            return (
              <PermissionCard
                key={p.id}
                part={p}
                taskId={taskId}
                provideInput={provideInput}
                onAnswered={() => {
                  if (!taskId) return;
                  patchParts(taskId, prev =>
                    prev.filter(x => !(x.type === 'permission_request' && x.requestId === p.requestId)),
                  );
                }}
              />
            );
          case 'runtime_log':
            return (
              <pre
                key={p.id}
                className={cn(
                  'text-[10px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-auto',
                  'rounded bg-black/30 px-2 py-1 text-text-faint',
                )}
              >
                [{p.stream}] {p.text}
              </pre>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    planning: 'Планирую',
    executing: 'Работаю',
    waiting_input: 'Жду ответ',
    synthesizing: 'Собираю итог',
    done: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено',
  };
  return map[s] ?? s;
}

function ToolCallCard({ part }: { part: Extract<MessagePart, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(!part.collapsed);
  const statusRu =
    part.status === 'running' ? 'идёт'
      : part.status === 'done' ? 'готово'
        : part.status === 'error' ? 'ошибка'
          : 'ожидание';
  return (
    <div className="lia-msg-tool-call rounded border border-border/30 bg-surface/30 text-[12px]">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-surface/50"
        onClick={() => setOpen(v => !v)}
      >
        <span className={cn(
          'inline-block w-1.5 h-1.5 rounded-full shrink-0',
          part.status === 'running' && 'bg-sky-400 animate-pulse',
          part.status === 'done' && 'bg-emerald-400',
          part.status === 'error' && 'bg-rose-400',
          part.status === 'pending' && 'bg-text-faint',
        )} />
        <span className="font-mono text-text-muted">{part.tool}</span>
        <span className={cn(
          'text-[10px] shrink-0',
          part.status === 'error' ? 'text-rose-300/90' : 'text-text-faint',
        )}>
          {statusRu}
        </span>
        <span className="text-text-faint truncate flex-1">
          {part.collapsed && part.summary ? part.summary : `шаг ${part.step}`}
        </span>
        <span className="text-text-faint">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="px-2 pb-2 text-[10px] font-mono text-text-faint whitespace-pre-wrap break-all max-h-40 overflow-auto">
          {JSON.stringify({ input: part.input, output: part.output }, null, 0).slice(0, 1500)}
        </pre>
      )}
    </div>
  );
}

function DiffPreview({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="px-2 pb-1 text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto border-t border-border/20">
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'block',
            line.startsWith('+') && !line.startsWith('+++') && 'lia-diff-add',
            line.startsWith('-') && !line.startsWith('---') && 'lia-diff-del',
            (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) && 'text-sky-300/70',
          )}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

function EditCard({
  part,
  taskId,
  expanded,
  applyMode,
}: {
  part: Extract<MessagePart, { type: 'edit_proposed' | 'edit_applied' | 'edit_rejected' }>;
  taskId?: string;
  expanded: boolean;
  applyMode: 'ask' | 'auto';
}) {
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const patchParts = useChatStore(s => s.patchAgentTurnParts);
  const markUndone = useChatStore(s => s.markActiveTaskFileChangeUndone);
  const diff = 'diff' in part ? part.diff : undefined;
  const preview = diff
    ? (showFull ? diff : diff.slice(0, DIFF_PREVIEW_CHARS))
    : '';
  const truncated = !!(diff && diff.length > DIFF_PREVIEW_CHARS && !showFull);

  const optimisticApply = (reject: boolean) => {
    if (!taskId || part.type !== 'edit_proposed') return;
    const changeId = part.changeId;
    patchParts(taskId, prev =>
      prev.map(p => {
        if (!(p.type === 'edit_proposed' && p.changeId === changeId)) return p;
        if (reject) {
          return {
            id: `edit-rej-${changeId}`,
            type: 'edit_rejected' as const,
            changeId,
            path: p.path,
            step: p.step,
          };
        }
        return {
          id: `edit-app-${changeId}`,
          type: 'edit_applied' as const,
          changeId,
          path: p.path,
          tool: p.tool,
          diff: p.diff,
          canUndo: true,
          step: p.step,
        };
      }),
    );
  };

  const apply = async () => {
    if (!taskId || part.type !== 'edit_proposed' || busy) return;
    setBusy(true);
    optimisticApply(false);
    try {
      await fetch(`/api/agent/${taskId}/file-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: part.changeId }),
      });
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!taskId || part.type !== 'edit_proposed' || busy) return;
    setBusy(true);
    optimisticApply(true);
    try {
      await fetch(`/api/agent/${taskId}/file-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: part.changeId, reject: true }),
      });
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!taskId || part.type !== 'edit_applied' || !part.canUndo || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent/${taskId}/file-undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: part.changeId }),
      });
      if (res.ok) {
        markUndone(part.changeId);
        patchParts(taskId, prev =>
          prev.map(p =>
            p.type === 'edit_applied' && p.changeId === part.changeId
              ? { ...p, canUndo: false }
              : p,
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded border bg-surface/40 text-[12px]',
        part.type === 'edit_proposed' && 'border-accent/45 border-l-[3px] border-l-accent',
        part.type === 'edit_applied' && 'border-emerald-500/35 border-l-[3px] border-l-emerald-500/70',
        part.type === 'edit_rejected' && 'border-border/40 opacity-70',
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="font-mono text-text-muted truncate flex-1">{part.path}</span>
        <span className="text-[10px] text-text-faint shrink-0">
          {EDIT_STATUS[part.type] ?? part.type}
        </span>
      </div>
      {expanded && preview && (
        <>
          <DiffPreview text={preview + (truncated ? '\n…' : '')} />
          {truncated && (
            <button
              type="button"
              className="text-sky-400 underline text-[10px] px-2 pb-1"
              onClick={() => setShowFull(true)}
            >
              ещё…
            </button>
          )}
        </>
      )}
      {part.type === 'edit_proposed' && applyMode === 'ask' && taskId && (
        <div className="flex flex-wrap gap-3 px-2 pb-2">
          <button type="button" className="text-emerald-400 text-[11px] underline disabled:opacity-50" disabled={busy} onClick={() => void apply()}>
            Применить
          </button>
          <button type="button" className="text-rose-400 text-[11px] underline disabled:opacity-50" disabled={busy} onClick={() => void reject()}>
            Отклонить
          </button>
        </div>
      )}
      {part.type === 'edit_applied' && part.canUndo && taskId && (
        <div className="flex flex-wrap gap-3 px-2 pb-2">
          <button type="button" className="text-amber-300/90 text-[11px] underline disabled:opacity-50" disabled={busy} onClick={() => void undo()}>
            Отменить файл
          </button>
        </div>
      )}
    </div>
  );
}

function AskCard({
  part,
  taskId,
  provideInput,
  onAnswered,
}: {
  part: Extract<MessagePart, { type: 'ask' }>;
  taskId?: string;
  provideInput: (id: string, answer: string) => Promise<boolean>;
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [part.question]);

  if (!taskId) {
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
        <div className="text-[11px] text-amber-200/80 mb-0.5">Вопрос</div>
        <div>{part.question}</div>
      </div>
    );
  }

  const submit = async () => {
    const text = answer.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const ok = await provideInput(taskId, text);
      if (ok) {
        setAnswer('');
        onAnswered();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 space-y-2">
      <div className="text-[11px] text-amber-200/80">Вопрос</div>
      <div className="text-[13px] leading-snug">{part.question}</div>
      <textarea
        ref={ref}
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        disabled={submitting}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Твой ответ…"
        rows={2}
        aria-label="Ответ агенту"
        className="w-full text-xs px-2 py-1.5 rounded-md border border-border/70 bg-background/90 placeholder:text-text-dim focus:outline-none focus:border-accent resize-none disabled:opacity-60"
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!answer.trim() || submitting}
          className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-accent-foreground disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
          Отправить
        </button>
      </div>
    </div>
  );
}

function PermissionCard({
  part,
  taskId,
  provideInput,
  onAnswered,
}: {
  part: Extract<MessagePart, { type: 'permission_request' }>;
  taskId?: string;
  provideInput: (id: string, answer: string) => Promise<boolean>;
  onAnswered: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const answer = async (yes: boolean) => {
    if (!taskId || busy) return;
    setBusy(true);
    try {
      const ok = await provideInput(taskId, yes ? 'да' : 'нет');
      if (ok) onAnswered();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-1.5 space-y-2">
      <div className="text-[11px] text-orange-200/80">
        Разрешение · {KIND_LABEL[part.kind] ?? part.kind}
      </div>
      <div className="text-[13px] leading-snug">{part.detail}</div>
      {taskId && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true)}
            className="px-2.5 py-1 text-[11px] rounded-md bg-emerald-600/90 text-white disabled:opacity-50"
          >
            Разрешить
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(false)}
            className="px-2.5 py-1 text-[11px] rounded-md border border-border/70 text-rose-300 disabled:opacity-50"
          >
            Запретить
          </button>
        </div>
      )}
    </div>
  );
}
