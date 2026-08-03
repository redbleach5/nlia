'use client';

// AgentWorkbench — агент рядом с чатом + Create Runtime Studio tabs.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Eye,
  FilePenLine,
  FolderTree,
  ListOrdered,
  Loader2,
  RotateCcw,
  Square,
  Terminal,
  LayoutTemplate,
} from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { agentWorkbenchSummary, isAgentBusyStatus } from '@/lib/agent/task-status-ui';
import { previewUrlForDesign } from '@/lib/agent/runtime/project-manifest';
import { cn } from '@/lib/utils';
import { FileChangesPanel } from './file-changes-panel';
import { WorkspacePanel } from './workspace-panel';
import { PanelErrorBoundary } from './panel-error-boundary';
import type { ProjectDesignLive, RuntimeLogLive, RuntimeStatusLive } from '@/stores/slices/types';

type TabId = 'extras' | 'design' | 'terminal' | 'preview' | 'edits' | 'files';

/** Collapsed mirror for Files / Runtime — plan/ask/steps live in the chat bubble. */
export function AgentWorkbench() {
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);
  const status = useChatStore(s => s.activeTaskStatus);
  const fileChanges = useChatStore(s => s.activeTaskFileChanges);
  const artifacts = useChatStore(s => s.activeTaskArtifacts);
  const error = useChatStore(s => s.activeTaskError);
  const agentTasks = useChatStore(s => s.agentTasks);
  const design = useChatStore(s => s.activeTaskDesign);
  const runtimeLogs = useChatStore(s => s.activeTaskRuntimeLogs);
  const runtime = useChatStore(s => s.activeTaskRuntime);

  const busy = isAgentBusyStatus(status);
  const editCount = fileChanges.length;
  const undoableCount = fileChanges.filter(c => c.canUndo && !c.undone).length;
  const hasExtras = Boolean(error || artifacts.length > 0);
  const hasEdits = editCount > 0;
  const hasDesign = Boolean(design);
  const hasRuntime = Boolean(runtime || runtimeLogs.length > 0);
  const show = Boolean(activeTaskId && (busy || hasEdits || hasExtras || hasDesign || hasRuntime));

  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabId>('edits');
  /** Once the user picks a tab, stop auto-switching until the next task. */
  const userPickedRef = useRef(false);
  const lastTaskIdRef = useRef<string | null>(null);
  const seenEditCountRef = useRef(0);
  const seenDesignKeyRef = useRef<string | null>(null);
  const seenRuntimeHealthyRef = useRef(false);

  // Reset auto-switch bookkeeping when the active task changes.
  useEffect(() => {
    if (activeTaskId === lastTaskIdRef.current) return;
    lastTaskIdRef.current = activeTaskId;
    userPickedRef.current = false;
    seenEditCountRef.current = 0;
    seenDesignKeyRef.current = null;
    seenRuntimeHealthyRef.current = false;
    setTab('edits');
    if (activeTaskId) setExpanded(false);
  }, [activeTaskId]);

  // Soft auto-switch tab only — do not auto-expand (bubble is UX source).
  useEffect(() => {
    if (!activeTaskId || userPickedRef.current) return;

    const designKey = design ? `${design.name}:${design.kind}` : null;
    const runtimeReady =
      runtime?.status === 'healthy'
      || (runtime?.status === 'running' && Boolean(runtime.previewUrl));

    if (runtimeReady && !seenRuntimeHealthyRef.current) {
      seenRuntimeHealthyRef.current = true;
      setTab(runtime?.previewUrl ? 'preview' : 'terminal');
      return;
    }

    if (designKey && designKey !== seenDesignKeyRef.current) {
      seenDesignKeyRef.current = designKey;
      setTab('design');
      return;
    }

    if (editCount > 0 && seenEditCountRef.current === 0) {
      seenEditCountRef.current = editCount;
      setTab('edits');
    } else if (editCount > seenEditCountRef.current) {
      seenEditCountRef.current = editCount;
    }
  }, [activeTaskId, editCount, design, design?.name, design?.kind, runtime?.status, runtime?.previewUrl]);

  const selectTab = (id: TabId) => {
    userPickedRef.current = true;
    setTab(id);
  };

  const summary = useMemo(() => agentWorkbenchSummary({
    status,
    busy,
    stepCount: 0,
    editCount,
    undoableCount,
    runtimeHealthy: runtime?.status === 'healthy',
    designKind: design?.kind,
  }), [busy, status, undoableCount, editCount, design?.kind, runtime?.status]);

  if (!show || !activeTaskId) return null;

  const tabs: { id: TabId; label: string; count?: number; show: boolean }[] = [
    { id: 'extras', label: 'Итог', show: hasExtras },
    { id: 'design', label: 'Дизайн', show: hasDesign || busy },
    { id: 'terminal', label: 'Терминал', count: runtimeLogs.length || undefined, show: hasRuntime || hasDesign },
    { id: 'preview', label: 'Preview', show: hasDesign || hasRuntime },
    { id: 'edits', label: 'Правки', count: editCount || undefined, show: hasEdits },
    { id: 'files', label: 'Файлы', show: hasEdits || hasDesign || hasRuntime },
  ];
  const visibleTabs = tabs.filter(t => t.show);
  const activeTab = visibleTabs.some(t => t.id === tab) ? tab : visibleTabs[0]?.id ?? 'files';

  return (
    <div className="lia-agent-workbench shrink-0 border-t border-border/70 bg-gradient-to-b from-surface/80 to-background">
      <div className="lia-chat-rail px-5 py-3 space-y-2.5">
        <div className="rounded-2xl border border-border/80 bg-surface/80 shadow-sm overflow-hidden lia-bubble-enter">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-2/50 transition-colors"
            aria-expanded={expanded}
          >
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                busy ? 'bg-accent/12 text-accent' : 'bg-accent-2/10 text-accent-2',
              )}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderTree className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground truncate">
                Файлы / Runtime
              </span>
              {summary && (
                <span className="block text-[11px] text-text-dim truncate">
                  {summary}
                  {agentTasks.length > 1 ? ` · задач ${agentTasks.length}` : ''}
                </span>
              )}
            </span>
            {hasEdits && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                <FilePenLine className="w-3 h-3" />
                {editCount}
              </span>
            )}
            <ChevronDown
              className={cn(
                'w-4 h-4 shrink-0 text-text-dim transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
          </button>

          {expanded && (
            <div className="border-t border-border/60">
              <div className="flex gap-0.5 px-2.5 pt-2.5 overflow-x-auto" role="tablist" aria-label="Панель агента">
                {visibleTabs.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === t.id}
                    onClick={() => selectTab(t.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap',
                      activeTab === t.id
                        ? 'bg-accent/12 text-accent'
                        : 'text-text-dim hover:text-foreground hover:bg-surface-2/60',
                    )}
                  >
                    {t.id === 'extras' && <ListOrdered className="w-3 h-3" />}
                    {t.id === 'design' && <LayoutTemplate className="w-3 h-3" />}
                    {t.id === 'terminal' && <Terminal className="w-3 h-3" />}
                    {t.id === 'preview' && <Eye className="w-3 h-3" />}
                    {t.id === 'edits' && <FilePenLine className="w-3 h-3" />}
                    {t.id === 'files' && <FolderTree className="w-3 h-3" />}
                    {t.label}
                    {typeof t.count === 'number' && t.count > 0 && (
                      <span className="tabular-nums opacity-80">{t.count}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="px-2.5 pb-2.5 pt-2 max-h-[min(58vh,34rem)] overflow-y-auto">
                <PanelErrorBoundary fallbackTitle="Панель агента недоступна">
                  {activeTab === 'extras' && (
                    <ExtrasTab error={error} artifacts={artifacts} />
                  )}
                  {activeTab === 'design' && (
                    <DesignTab design={design} />
                  )}
                  {activeTab === 'terminal' && (
                    <TerminalTab
                      taskId={activeTaskId}
                      logs={runtimeLogs}
                      runtime={runtime}
                    />
                  )}
                  {activeTab === 'preview' && (
                    <PreviewTab
                      taskId={activeTaskId}
                      design={design}
                      runtime={runtime}
                    />
                  )}
                  {activeTab === 'edits' && (
                    <div className="lia-workbench-embed rounded-xl border border-border/70 bg-background/60 overflow-hidden">
                      {hasEdits ? (
                        <FileChangesPanel taskId={activeTaskId} />
                      ) : (
                        <EmptyHint>
                          Когда Лия изменит файлы, здесь появятся диффы и Undo.
                        </EmptyHint>
                      )}
                    </div>
                  )}
                  {activeTab === 'files' && (
                    <div className="lia-workbench-embed rounded-xl border border-border/70 bg-background/60 p-2.5">
                      <WorkspacePanel taskId={activeTaskId} episodeId={currentEpisodeId} />
                    </div>
                  )}
                </PanelErrorBoundary>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-5 text-center text-[11px] text-text-dim leading-relaxed">
      {children}
    </p>
  );
}

function DesignTab({ design }: { design: ProjectDesignLive | null }) {
  if (!design) {
    return <EmptyHint>Лия ещё не предложила стек и структуру — появится на этапе Design Gate.</EmptyHint>;
  }
  return (
    <div className="space-y-4 px-1 py-1">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">{design.name}</h3>
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-dim">
          {design.kind}
        </span>
      </header>

      <section className="space-y-1.5">
        <h4 className="text-[11px] font-medium text-muted-foreground">Стек</h4>
        <div className="flex flex-wrap gap-1.5">
          {design.stack.map((s) => (
            <span
              key={s}
              className="rounded-md border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-foreground/90"
            >
              {s}
            </span>
          ))}
        </div>
      </section>

      <section className="space-y-1.5">
        <h4 className="text-[11px] font-medium text-muted-foreground">Файлы</h4>
        <ul className="rounded-xl border border-border/60 bg-background/50 divide-y divide-border/50 overflow-hidden">
          {design.tree.map((t) => (
            <li key={t.path} className="flex items-baseline gap-3 px-2.5 py-1.5 text-[11px]">
              <code className="font-mono text-accent shrink-0">{t.path}</code>
              <span className="text-text-dim truncate min-w-0">{t.role}</span>
            </li>
          ))}
        </ul>
      </section>

      {(design.scripts.dev || design.scripts.start) && (
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-medium text-muted-foreground">Scripts</h4>
          <div className="rounded-xl border border-border/60 bg-background/50 px-2.5 py-2 space-y-1 font-mono text-[11px] text-foreground/85">
            {design.scripts.dev && (
              <p><span className="text-text-dim">dev</span> · {design.scripts.dev}</p>
            )}
            {design.scripts.start && (
              <p><span className="text-text-dim">start</span> · {design.scripts.start}</p>
            )}
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h4 className="text-[11px] font-medium text-muted-foreground">Критерий готовности</h4>
        <p className="text-[12px] text-foreground/90 leading-relaxed">{design.acceptance}</p>
      </section>
    </div>
  );
}

function TerminalTab({
  taskId,
  logs,
  runtime,
}: {
  taskId: string;
  logs: RuntimeLogLive[];
  runtime: RuntimeStatusLive | null;
}) {
  const [busyAction, setBusyAction] = useState<'stop' | 'restart' | null>(null);

  async function runtimeAction(action: 'stop' | 'restart') {
    setBusyAction(action);
    try {
      await fetch(`/api/agent/${taskId}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          {runtime?.status ?? 'idle'}
          {runtime?.port != null ? ` · :${runtime.port}` : ''}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-dim hover:bg-surface-2/60 hover:text-foreground disabled:opacity-40"
          disabled={busyAction !== null || !runtime || runtime.status === 'stopped' || runtime.status === 'idle'}
          onClick={() => runtimeAction('stop')}
        >
          <Square className="w-3 h-3" />
          Стоп
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-dim hover:bg-surface-2/60 hover:text-foreground disabled:opacity-40"
          disabled={busyAction !== null}
          onClick={() => runtimeAction('restart')}
        >
          <RotateCcw className={cn('w-3 h-3', busyAction === 'restart' && 'animate-spin')} />
          Рестарт
        </button>
      </div>
      {runtime?.lastError && (
        <p className="px-2 text-[11px] text-destructive/90">{runtime.lastError}</p>
      )}
      {logs.length === 0 ? (
        <EmptyHint>Логи появятся, когда Лия вызовет runtime_start.</EmptyHint>
      ) : (
        <pre className="lia-terminal-log rounded-xl border border-border/60 text-[10px] font-mono leading-relaxed px-2.5 py-2 max-h-[22rem] overflow-auto">
          {logs.slice(-120).map((l, i) => (
            <div
              key={`${l.ts}-${i}`}
              className={cn(
                l.stream === 'stderr' && 'text-destructive/90',
                l.stream === 'system' && 'text-warning/90',
              )}
            >
              <span className="opacity-40 mr-1.5">{l.stream === 'system' ? '·' : l.stream === 'stderr' ? '!' : '>'}</span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function PreviewTab({
  taskId,
  design,
  runtime,
}: {
  taskId: string;
  design: ProjectDesignLive | null;
  runtime: RuntimeStatusLive | null;
}) {
  const [busyAction, setBusyAction] = useState<'stop' | 'restart' | null>(null);
  const [frameFailed, setFrameFailed] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  const url = runtime?.previewUrl
    ?? (design ? previewUrlForDesign(design) : null);
  const wantsIframe = design?.preview?.type === 'iframe'
    || Boolean(runtime?.previewUrl)
    || (design?.preview?.type !== 'terminal' && Boolean(design?.preview?.port));
  const healthy = runtime?.status === 'healthy';
  const starting = runtime?.status === 'starting' || runtime?.status === 'running';

  useEffect(() => {
    setFrameFailed(false);
    setLoadTimedOut(false);
  }, [url, runtime?.status]);

  // If iframe stays blank while "healthy", surface a timeout hint.
  useEffect(() => {
    if (!healthy || !url || frameFailed) return;
    const t = window.setTimeout(() => setLoadTimedOut(true), 8000);
    return () => window.clearTimeout(t);
  }, [healthy, url, frameFailed]);

  async function runtimeAction(action: 'stop' | 'restart') {
    setBusyAction(action);
    try {
      await fetch(`/api/agent/${taskId}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } finally {
      setBusyAction(null);
    }
  }

  if (design?.preview?.type === 'terminal' && !runtime?.previewUrl) {
    return (
      <EmptyHint>
        Для этого артефакта preview — терминал (см. вкладку Терминал).
        {url ? ` URL: ${url}` : ''}
      </EmptyHint>
    );
  }

  if (!wantsIframe && !url) {
    return (
      <EmptyHint>
        Preview появится после Design Gate и runtime_start.
      </EmptyHint>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <span className="text-[10px] font-mono text-text-dim truncate max-w-[min(100%,20rem)]">
          {url ?? 'нет URL'}
          {runtime?.status ? ` · ${runtime.status}` : ''}
        </span>
        <div className="flex-1" />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
          >
            <ExternalLink className="w-3 h-3" />
            Открыть
          </a>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-dim hover:bg-surface-2/60 disabled:opacity-40"
          disabled={busyAction !== null || !healthy}
          onClick={() => runtimeAction('stop')}
        >
          <Square className="w-3 h-3" />
          Стоп
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-dim hover:bg-surface-2/60 disabled:opacity-40"
          disabled={busyAction !== null}
          onClick={() => runtimeAction('restart')}
        >
          <RotateCcw className={cn('w-3 h-3', busyAction === 'restart' && 'animate-spin')} />
          Рестарт
        </button>
      </div>

      {!url ? (
        <EmptyHint>
          Preview появится после успешного runtime_start (status: healthy).
        </EmptyHint>
      ) : healthy ? (
        <div className="relative rounded-xl border border-border/70 overflow-hidden bg-surface-2/40">
          {(frameFailed || loadTimedOut) && (
            <div className="absolute inset-x-0 top-0 z-10 px-3 py-2 bg-warning/15 border-b border-warning/30 text-[11px] text-foreground/90">
              {frameFailed
                ? 'Не удалось встроить preview — открой в новой вкладке.'
                : 'Страница долго не отвечает — попробуй «Открыть» или «Рестарт».'}
            </div>
          )}
          <iframe
            key={`${taskId}:${url}:${runtime?.pid ?? 'nopid'}`}
            title="Lia artifact preview"
            src={url}
            className="w-full h-[min(48vh,28rem)] bg-[var(--surface)]"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
            onError={() => setFrameFailed(true)}
            onLoad={() => {
              setFrameFailed(false);
              setLoadTimedOut(false);
            }}
          />
        </div>
      ) : starting ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 rounded-xl border border-border/60 bg-surface-2/30">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
          <p className="text-[11px] text-text-dim">Поднимаю preview…</p>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-accent hover:underline"
            >
              Открыть пока вручную
            </a>
          )}
        </div>
      ) : (
        <EmptyHint>
          {runtime?.status === 'unhealthy'
            ? 'Runtime unhealthy — смотри Терминал или нажми «Рестарт».'
            : 'Процесс остановлен — нажми «Рестарт», чтобы снова поднять preview.'}
        </EmptyHint>
      )}
    </div>
  );
}

function ExtrasTab({
  error,
  artifacts,
}: {
  error: string | null;
  artifacts: Array<{ filename: string; url: string }>;
}) {
  if (!error && artifacts.length === 0) {
    return <EmptyHint>Ошибки и артефакты появятся здесь. План и шаги — в ленте чата.</EmptyHint>;
  }

  return (
    <div className="space-y-4 px-1 py-1">
      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-[11px] font-medium text-destructive mb-1">Ошибка</p>
          <p className="text-[12px] text-foreground/90 leading-relaxed">{error}</p>
        </div>
      )}

      {artifacts.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-[11px] font-medium text-muted-foreground">Артефакты</h4>
          <ul className="rounded-xl border border-border/60 bg-background/50 divide-y divide-border/50 overflow-hidden">
            {artifacts.map((a, i) => (
              <li key={`${a.url}-${i}`}>
                <a
                  href={a.url}
                  download={a.filename}
                  className="block px-3 py-2 text-[12px] text-accent hover:bg-accent/5 font-mono truncate transition-colors"
                >
                  {a.filename}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
