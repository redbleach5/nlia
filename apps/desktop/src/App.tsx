/**
 * Lia v3 — App shell. "Clay & Cream" aesthetic (Anthropic-inspired).
 *
 * Layout: sidebar | main | right panel.
 * Top bar: sidebar toggle · title (serif) · right-panel cycle · settings · theme.
 *
 * Signature elements:
 *   - Newsreader serif for titles with subtle letter-spacing
 *   - Hairline borders instead of shadows
 *   - Anthropic-style asterisk spark in accent color
 *   - Editorial small-caps labels in mono
 */

import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Settings,
  PanelRight,
  PanelLeft,
  Sparkles,
  MessageSquare,
  Wrench,
  X,
  Bot,
} from "lucide-react";
import { EpisodesSidebar } from "./components/EpisodesSidebar.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { WorkspacePanel } from "./components/WorkspacePanel.js";
import { ThemeToggle } from "./components/ui/ThemeToggle.js";
import { Button } from "./components/ui/Button.js";
import { useAgentStore } from "./stores/agent.js";
import { useChatStore } from "./stores/chat.js";
import * as api from "./lib/api.js";

const VrmAvatar = lazy(() =>
  import("./components/VrmAvatar.js").then((m) => ({ default: m.VrmAvatar })),
);

type RightPanel = "workspace" | "avatar" | null;

class AvatarErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: string | null }
> {
  override state: { error: string | null } = { error: null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-[var(--color-fg-muted)]">
            Не удалось загрузить 3D-движок аватара
            <br />
            <span className="text-[var(--color-fg-faint)] mt-1 block">{this.state.error}</span>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanel, setRightPanel] = useState<RightPanel>("avatar");
  const [vrmExists, setVrmExists] = useState(false);
  const [vrmSrc, setVrmSrc] = useState<string | null>(null);

  const agentTaskId = useAgentStore((s) => s.task?.id ?? null);
  const clearAgent = useAgentStore((s) => s.clear);

  const refreshVrm = async () => {
    try {
      const result = await api.checkVrmExists();
      setVrmExists(result.exists);
      // Cache-bust so browser/WebGL always refetch after upload
      setVrmSrc(result.exists ? `/api/settings/vrm?t=${Date.now()}` : null);
    } catch {
      setVrmExists(false);
      setVrmSrc(null);
    }
  };

  useEffect(() => {
    void refreshVrm();
    const t = window.setTimeout(() => void refreshVrm(), 2000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (rightPanel === "avatar") void refreshVrm();
  }, [rightPanel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setRightPanel((v) => (v === "workspace" ? null : "workspace"));
      } else if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setRightPanel((v) => (v === "avatar" ? null : "avatar"));
      } else if (e.key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
        else if (rightPanel) setRightPanel(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsOpen, rightPanel]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-fg)]">
      {sidebarOpen && <EpisodesSidebar />}

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 shrink-0 border-b border-[var(--color-border-soft)] flex items-center px-3 gap-1.5 bg-[var(--color-bg)]">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Скрыть панель эпизодов" : "Показать панель эпизодов"}
            aria-label="Переключить панель эпизодов"
          >
            <PanelLeft size={15} />
          </Button>

          <div className="h-3.5 w-px bg-[var(--color-border)] mx-1" />

          <div className="flex-1 min-w-0 flex items-center gap-2 text-sm">
            <AgentOrChatTitle agentTaskId={agentTaskId} />
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRightPanel((v) => (v === "workspace" ? null : "workspace"))}
            title="Рабочая область (Ctrl+B)"
            aria-label="Рабочая область"
            aria-pressed={rightPanel === "workspace"}
            className={rightPanel === "workspace" ? "bg-[var(--color-ember-subtle)] text-[var(--color-ember-deep)]" : ""}
          >
            <PanelRight size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRightPanel((v) => (v === "avatar" ? null : "avatar"))}
            title="Аватар (Ctrl+A)"
            aria-label="Аватар"
            aria-pressed={rightPanel === "avatar"}
            className={rightPanel === "avatar" ? "bg-[var(--color-ember-subtle)] text-[var(--color-ember-deep)]" : ""}
          >
            <Bot size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            title="Настройки (Ctrl+,)"
            aria-label="Настройки"
          >
            <Settings size={15} />
          </Button>
          <ThemeToggle />
        </header>

        {agentTaskId ? (
          <div className="flex-1 flex flex-col min-w-0 relative">
            <AgentCenterView />
            <div className="absolute bottom-4 right-4 z-10 flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void useAgentStore.getState().cancel()}
              >
                Отменить
              </Button>
              <Button variant="secondary" size="sm" onClick={clearAgent}>
                <X size={13} />
                Назад в чат
              </Button>
            </div>
          </div>
        ) : (
          <ChatPanel
            onAgentTaskStart={(taskId) => {
              void useAgentStore.getState().track(taskId);
            }}
          />
        )}
      </main>

      {rightPanel === "workspace" && (
        <WorkspacePanel onClose={() => setRightPanel(null)} />
      )}
      {rightPanel === "avatar" && (
        <AvatarPanel
          onClose={() => setRightPanel(null)}
          vrmSrc={vrmSrc}
          vrmExists={vrmExists}
          onOpenSettings={() => {
            setSettingsOpen(true);
          }}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onVrmChange={(exists) => {
          setVrmExists(exists);
          setVrmSrc(exists ? `/api/settings/vrm?t=${Date.now()}` : null);
          if (exists) setRightPanel("avatar");
        }}
      />
    </div>
  );
}

function AgentOrChatTitle({ agentTaskId }: { agentTaskId: string | null }) {
  if (agentTaskId) {
    return (
      <>
        <Wrench size={13} className="text-[var(--color-ember)]" />
        <span className="font-display text-[15px] font-medium text-[var(--color-fg-ink)]">Агент</span>
        <span className="text-[var(--color-fg-faint)] text-xs ml-1">·</span>
        <span className="editorial-label">task mode</span>
      </>
    );
  }
  return (
    <>
      <MessageSquare size={13} className="text-[var(--color-ember)]" />
      <span className="font-display text-[15px] font-medium text-[var(--color-fg-ink)]">Чат</span>
      <span className="text-[var(--color-fg-faint)] text-xs ml-1">·</span>
      <span className="editorial-label">dialogue</span>
    </>
  );
}

function AgentCenterView() {
  const events = useAgentStore((s) => s.events);
  const streaming = useAgentStore((s) => s.isStreaming);
  const task = useAgentStore((s) => s.task);
  const submittingAnswer = useAgentStore((s) => s.submittingAnswer);
  const submitAnswer = useAgentStore((s) => s.submitAnswer);
  const [answer, setAnswer] = useState("");

  const pendingQuestion =
    task?.status === "waiting_input"
      ? [...events].reverse().find((e) => e.type === "ask_user")
      : undefined;

  const hasPendingGit =
    task?.status === "waiting_input" &&
    [...events].reverse().some((e) => {
      if (
        e.type !== "git_propose_commit" &&
        e.type !== "git_propose_push" &&
        e.type !== "deploy_propose" &&
        e.type !== "ssh_propose"
      ) {
        return false;
      }
      return !events.some(
        (r) =>
          ((r.type === "git_committed" ||
            r.type === "git_pushed" ||
            r.type === "git_rejected" ||
            r.type === "deploy_done" ||
            r.type === "deploy_rejected" ||
            r.type === "ssh_done" ||
            r.type === "ssh_rejected") &&
            r.actionId === e.actionId),
      );
    });

  const questionText =
    !hasPendingGit && pendingQuestion && pendingQuestion.type === "ask_user"
      ? pendingQuestion.question
      : null;

  const statusLabel =
    task?.status === "waiting_input"
      ? hasPendingGit
        ? "Ждёт Confirm…"
        : "Ждёт ответа…"
      : streaming
        ? "Выполняется…"
        : task?.status === "done"
          ? "Завершено"
          : task?.status === "failed"
            ? "Ошибка"
            : "Остановлено";

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <div className="px-8 py-6 border-b border-[var(--color-border-soft)]">
        <div className="flex items-center gap-2 editorial-label">
          <Sparkles size={11} className="text-[var(--color-ember)]" />
          {task?.templateName === "coder" ? "Mode · Code" : "Mode · Agent"}
        </div>
        <p className="font-display text-[24px] mt-2 text-[var(--color-fg-ink)] truncate tracking-tight leading-tight">
          {task?.goal}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)] mt-2 flex items-center gap-2">
          {(streaming || task?.status === "waiting_input") && (
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
          )}
          {statusLabel}
          {task?.fsScope && (
            <span className="text-[var(--color-fg-faint)] font-mono truncate max-w-[280px]" title={task.fsScope}>
              · {task.fsScope}
            </span>
          )}
        </p>
        <p className="text-[11px] text-[var(--color-fg-faint)] mt-2 font-mono">
          Apply → verify → Commit → Push
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-5 space-y-2 pb-28">
        {events.length === 0 && streaming && (
          <p className="text-sm text-[var(--color-fg-muted)] italic py-10 text-center font-display">
            Подключаюсь…
          </p>
        )}
        <FileChangesToolbar />
        {events.map((ev, i) => (
          <div key={i} className="max-w-3xl animate-fade-in">
            {renderAgentEvent(ev)}
          </div>
        ))}
      </div>

      {questionText && (
        <div className="shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] px-8 py-4">
          <p className="text-xs text-[var(--color-info)] font-display mb-2">Ответ агенту</p>
          <form
            className="flex gap-2 max-w-3xl"
            onSubmit={(e) => {
              e.preventDefault();
              const text = answer.trim();
              if (!text || submittingAnswer) return;
              void submitAnswer(text).then(() => setAnswer(""));
            }}
          >
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Напишите ответ…"
              disabled={submittingAnswer}
              className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-ember)]"
              autoFocus
            />
            <Button type="submit" size="sm" disabled={!answer.trim() || submittingAnswer}>
              {submittingAnswer ? "…" : "Отправить"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

function renderAgentEvent(ev: import("@lia/shared").AgentEvent): React.ReactNode {
  switch (ev.type) {
    case "status":
      return (
        <div className="flex items-center gap-2.5 text-xs text-[var(--color-fg-muted)] italic py-1 pl-1">
          <span className="thinking-dots">
            <span />
            <span />
            <span />
          </span>
          {ev.label}
        </div>
      );
    case "text_delta":
      return <div className="prose-chat text-sm whitespace-pre-wrap">{ev.text}</div>;
    case "tool_start":
      return (
        <div className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)] py-1 pl-1 font-mono">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-info)] animate-pulse" />
          <span className="text-[var(--color-ember-deep)]">{ev.tool}()</span>
          <span className="text-[var(--color-fg-faint)] truncate">{String(ev.input).slice(0, 80)}</span>
        </div>
      );
    case "tool_end":
      return <ToolEventCard event={ev} />;
    case "ask_user":
      return (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-info)]/40 bg-[var(--color-info-subtle)] p-3.5 text-sm my-1.5">
          <p className="font-display text-[13px] font-medium text-[var(--color-info)] mb-1">Вопрос</p>
          <p className="text-[var(--color-fg-ink)] leading-relaxed">{ev.question}</p>
        </div>
      );
    case "user_answer":
      return (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3.5 text-sm my-1.5">
          <p className="font-display text-[13px] font-medium text-[var(--color-fg-muted)] mb-1">Ваш ответ</p>
          <p className="text-[var(--color-fg-ink)] leading-relaxed">{ev.answer}</p>
        </div>
      );
    case "file_propose":
      return <FileProposeCard event={ev} />;
    case "file_applied":
      return <FileAppliedCard event={ev} />;
    case "file_rejected":
      return (
        <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
          ✗ отклонено · {ev.path}
        </div>
      );
    case "file_undone":
      return (
        <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
          ↶ откат · {ev.path}
        </div>
      );
    case "git_propose_commit":
      return <GitCommitCard event={ev} />;
    case "git_propose_push":
      return <GitPushCard event={ev} />;
    case "git_committed":
      return (
        <div className="text-xs text-[var(--color-success)] py-1 font-mono">
          ✓ commit {ev.sha} · {ev.message}
        </div>
      );
    case "git_pushed":
      return (
        <div className="text-xs text-[var(--color-success)] py-1 font-mono">
          ✓ push {ev.remote}/{ev.branch}
        </div>
      );
    case "git_rejected":
      return (
        <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
          ✗ git {ev.kind} отклонён
        </div>
      );
    case "deploy_propose":
      return <DeployCard event={ev} />;
    case "deploy_done":
      return (
        <div className={`text-xs py-1 font-mono ${ev.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
          {ev.ok ? "✓" : "✗"} deploy {ev.preset} · {ev.summary}
        </div>
      );
    case "deploy_rejected":
      return (
        <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
          ✗ deploy {ev.preset} отклонён
        </div>
      );
    case "ssh_propose":
      return <SshCard event={ev} />;
    case "ssh_done":
      return (
        <div className={`text-xs py-1 font-mono ${ev.ok ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
          {ev.ok ? "✓" : "✗"} ssh {ev.host} · {ev.summary}
        </div>
      );
    case "ssh_rejected":
      return (
        <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
          ✗ ssh {ev.host} отклонён
        </div>
      );
    case "verify_start":
      return (
        <div className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)] py-1 pl-1 font-mono">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-info)] animate-pulse" />
          verify · {ev.names.join(", ")}
        </div>
      );
    case "verify_done":
      return (
        <div
          className={`rounded-[var(--radius-md)] border p-3 text-xs my-1.5 font-mono ${
            ev.ok
              ? "border-[var(--color-success)]/40 bg-[var(--color-success-subtle)] text-[var(--color-success)]"
              : "border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)] text-[var(--color-danger)]"
          }`}
        >
          {ev.ok ? "✓" : "✗"} verify · {ev.summary}
          {ev.results.length > 0 && (
            <div className="mt-1 text-[var(--color-fg-muted)]">
              {ev.results.map((r) => (
                <div key={r.name}>
                  {r.ok ? "✓" : "✗"} {r.name} ({r.durationMs}ms)
                </div>
              ))}
            </div>
          )}
        </div>
      );
    case "finalize":
      return (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-success)]/40 bg-[var(--color-success-subtle)] p-3.5 text-sm my-1.5">
          <p className="font-display text-[13px] font-medium text-[var(--color-success)]">Готово</p>
          <p className="text-xs mt-1 text-[var(--color-fg-muted)] leading-relaxed">{ev.summary}</p>
        </div>
      );
    case "error":
      return (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)] p-3.5 text-sm my-1.5">
          <p className="text-[var(--color-danger)]">{ev.message}</p>
        </div>
      );
    default:
      return null;
  }
}

function FileChangesToolbar() {
  const events = useAgentStore((s) => s.events);
  const applyAll = useAgentStore((s) => s.applyAllFileChanges);
  const rejectAll = useAgentStore((s) => s.rejectAllFileChanges);
  const undoAll = useAgentStore((s) => s.undoAllFileChanges);
  const [busy, setBusy] = useState(false);

  const proposedIds = new Set(
    events.filter((e) => e.type === "file_propose").map((e) => e.changeId),
  );
  const resolvedIds = new Set(
    events
      .filter(
        (e) =>
          e.type === "file_applied" || e.type === "file_rejected" || e.type === "file_undone",
      )
      .map((e) => e.changeId),
  );
  const pendingCount = [...proposedIds].filter((id) => !resolvedIds.has(id)).length;

  const appliedAlive = events.filter((e) => {
    if (e.type !== "file_applied") return false;
    const laterUndone = events.some(
      (u) => u.type === "file_undone" && u.changeId === e.changeId,
    );
    return !laterUndone;
  }).length;

  if (pendingCount === 0 && appliedAlive === 0) return null;

  return (
    <div className="max-w-3xl mb-3 rounded-[var(--radius-md)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 flex flex-wrap items-center gap-2">
      <span className="editorial-label text-[var(--color-fg-muted)] mr-auto">
        Changes · {pendingCount} pending · {appliedAlive} applied
      </span>
      {pendingCount > 0 && (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void applyAll().finally(() => setBusy(false));
            }}
          >
            Apply all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void rejectAll().finally(() => setBusy(false));
            }}
          >
            Reject all
          </Button>
        </>
      )}
      {appliedAlive > 0 && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void undoAll().finally(() => setBusy(false));
          }}
        >
          Undo all
        </Button>
      )}
    </div>
  );
}

function FileProposeCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "file_propose" };
}) {
  const events = useAgentStore((s) => s.events);
  const applyFileChange = useAgentStore((s) => s.applyFileChange);
  const rejectFileChange = useAgentStore((s) => s.rejectFileChange);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const resolved = events.some(
    (e) =>
      (e.type === "file_applied" || e.type === "file_rejected" || e.type === "file_undone") &&
      e.changeId === event.changeId,
  );

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-ember)]/35 bg-[var(--color-ember-subtle)] p-3.5 text-sm my-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[13px] font-medium text-[var(--color-ember-deep)]">
            Правка файла
          </p>
          <p className="font-mono text-xs text-[var(--color-fg-ink)] mt-1 truncate" title={event.path}>
            {event.path}
            {event.created ? " · новый" : ""} · {event.tool}
          </p>
        </div>
        {!resolved && (
          <div className="flex gap-1.5 shrink-0">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void applyFileChange(event.changeId).finally(() => setBusy(false));
              }}
            >
              Apply
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void rejectFileChange(event.changeId).finally(() => setBusy(false));
              }}
            >
              Reject
            </Button>
          </div>
        )}
      </div>
      {event.diff && (
        <>
          <button
            type="button"
            className="text-[10px] editorial-label text-[var(--color-fg-faint)] mt-2"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "скрыть diff" : "показать diff"}
          </button>
          {expanded && (
            <pre className="mt-2 p-3 bg-[var(--color-bg-grain)] rounded-[var(--radius-sm)] text-[10px] overflow-x-auto max-h-48 whitespace-pre-wrap border border-[var(--color-border-soft)] font-mono leading-relaxed">
              {event.diff}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function FileAppliedCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "file_applied" };
}) {
  const events = useAgentStore((s) => s.events);
  const undoFileChange = useAgentStore((s) => s.undoFileChange);
  const [busy, setBusy] = useState(false);
  const undone = events.some((e) => e.type === "file_undone" && e.changeId === event.changeId);
  if (undone) {
    return (
      <div className="text-xs text-[var(--color-fg-muted)] py-1 font-mono">
        ↶ откат · {event.path}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-success)] py-1 font-mono">
      <span>✓ применено · {event.path}</span>
      <button
        type="button"
        disabled={busy}
        className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg-ink)] underline-offset-2 hover:underline"
        onClick={() => {
          setBusy(true);
          void undoFileChange(event.changeId).finally(() => setBusy(false));
        }}
      >
        Undo
      </button>
    </div>
  );
}

function gitActionResolved(
  events: import("@lia/shared").AgentEvent[],
  actionId: string,
): boolean {
  return events.some(
    (e) =>
      (e.type === "git_committed" ||
        e.type === "git_pushed" ||
        e.type === "git_rejected" ||
        e.type === "deploy_done" ||
        e.type === "deploy_rejected" ||
        e.type === "ssh_done" ||
        e.type === "ssh_rejected") &&
      e.actionId === actionId,
  );
}

function GitCommitCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "git_propose_commit" };
}) {
  const events = useAgentStore((s) => s.events);
  const confirmGit = useAgentStore((s) => s.confirmGit);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(event.message);
  const resolved = gitActionResolved(events, event.actionId);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-info)]/40 bg-[var(--color-info-subtle)] p-3.5 text-sm my-1.5">
      <p className="font-display text-[13px] font-medium text-[var(--color-info)] mb-1">
        Git commit
      </p>
      <p className="text-xs text-[var(--color-fg-muted)] mb-2">
        {event.branch ? `branch · ${event.branch}` : "branch · ?"} · {event.files.length} files
      </p>
      <p className="text-xs text-[var(--color-fg-ink)] mb-2 whitespace-pre-wrap">{event.summary}</p>
      {!resolved && (
        <>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full mb-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-ember)]"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={busy || !message.trim()}
              onClick={() => {
                setBusy(true);
                void confirmGit(event.actionId, "confirm", message.trim()).finally(() =>
                  setBusy(false),
                );
              }}
            >
              Commit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void confirmGit(event.actionId, "reject").finally(() => setBusy(false));
              }}
            >
              Reject
            </Button>
          </div>
        </>
      )}
      {event.files.length > 0 && (
        <pre className="mt-2 text-[10px] font-mono text-[var(--color-fg-faint)] max-h-24 overflow-y-auto">
          {event.files.slice(0, 20).join("\n")}
        </pre>
      )}
    </div>
  );
}

function GitPushCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "git_propose_push" };
}) {
  const events = useAgentStore((s) => s.events);
  const confirmGit = useAgentStore((s) => s.confirmGit);
  const [busy, setBusy] = useState(false);
  const resolved = gitActionResolved(events, event.actionId);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-ember)]/40 bg-[var(--color-ember-subtle)] p-3.5 text-sm my-1.5">
      <p className="font-display text-[13px] font-medium text-[var(--color-ember-deep)] mb-1">
        Git push
      </p>
      <p className="text-xs text-[var(--color-fg-ink)] mb-2">
        {event.summary}
      </p>
      <p className="text-xs font-mono text-[var(--color-fg-muted)] mb-3">
        {event.remote}/{event.branch ?? "HEAD"}
      </p>
      {!resolved && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "confirm").finally(() => setBusy(false));
            }}
          >
            Push
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "reject").finally(() => setBusy(false));
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function DeployCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "deploy_propose" };
}) {
  const events = useAgentStore((s) => s.events);
  const confirmGit = useAgentStore((s) => s.confirmGit);
  const [busy, setBusy] = useState(false);
  const resolved = gitActionResolved(events, event.actionId);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/35 bg-[var(--color-danger-subtle)] p-3.5 text-sm my-1.5">
      <p className="font-display text-[13px] font-medium text-[var(--color-danger)] mb-1">
        Deploy · {event.preset}
      </p>
      <p className="text-xs text-[var(--color-fg-ink)] mb-1">{event.summary}</p>
      <p className="text-xs font-mono text-[var(--color-fg-muted)] mb-3">{event.command}</p>
      {!resolved && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "confirm").finally(() => setBusy(false));
            }}
          >
            Deploy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "reject").finally(() => setBusy(false));
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function SshCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "ssh_propose" };
}) {
  const events = useAgentStore((s) => s.events);
  const confirmGit = useAgentStore((s) => s.confirmGit);
  const [busy, setBusy] = useState(false);
  const resolved = gitActionResolved(events, event.actionId);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-info)]/40 bg-[var(--color-info-subtle)] p-3.5 text-sm my-1.5">
      <p className="font-display text-[13px] font-medium text-[var(--color-info)] mb-1">
        SSH · {event.host}
      </p>
      <p className="text-xs text-[var(--color-fg-ink)] mb-1">{event.summary}</p>
      <pre className="text-[10px] font-mono text-[var(--color-fg-muted)] mb-3 whitespace-pre-wrap">
        {event.command}
      </pre>
      {!resolved && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "confirm").finally(() => setBusy(false));
            }}
          >
            Run SSH
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmGit(event.actionId, "reject").finally(() => setBusy(false));
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function ToolEventCard({
  event,
}: {
  event: import("@lia/shared").AgentEvent & { type: "tool_end" };
}) {
  const [expanded, setExpanded] = useState(false);
  const success = event.success;
  const outText =
    event.output == null
      ? ""
      : typeof event.output === "string"
      ? event.output
      : JSON.stringify(event.output, null, 2);

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`w-full text-left rounded-[var(--radius-md)] border p-3 text-xs my-1 transition-colors ${
        success
          ? "border-[var(--color-border-soft)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
          : "border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)]"
      }`}
      aria-expanded={expanded}
    >
      <div className="flex items-center justify-between">
        <span className={`font-mono ${success ? "text-[var(--color-ember-deep)]" : "text-[var(--color-danger)]"}`}>
          {success ? "✓" : "✗"} {event.tool}()
        </span>
        <span className="text-[var(--color-fg-faint)] text-[10px] editorial-label">
          {expanded ? "скрыть" : "раскрыть"}
        </span>
      </div>
      <p className="text-[var(--color-fg-muted)] mt-1.5 line-clamp-2 leading-relaxed">{event.summary}</p>
      {expanded && outText && (
        <pre className="mt-2.5 p-3 bg-[var(--color-bg-grain)] rounded-[var(--radius-sm)] text-[10px] overflow-x-auto max-h-48 whitespace-pre-wrap border border-[var(--color-border-soft)] font-mono leading-relaxed">
          {outText}
        </pre>
      )}
    </button>
  );
}

function AvatarPanel({
  onClose,
  vrmSrc,
  vrmExists,
  onOpenSettings,
}: {
  onClose: () => void;
  vrmSrc: string | null;
  vrmExists: boolean;
  onOpenSettings: () => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const chatStreaming = useChatStore((s) => s.streaming.isStreaming);
  const agentStreaming = useAgentStore((s) => s.isStreaming);
  /** Slightly livelier idle while Lia is producing a reply (no lip-sync). */
  const alive = chatStreaming || agentStreaming;

  return (
    <aside className="w-80 shrink-0 border-l border-[var(--color-border-soft)] flex flex-col bg-[var(--color-surface)]">
      <header className="h-12 shrink-0 px-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <h2 className="editorial-label">Аватар</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть панель">
          <X size={15} />
        </Button>
      </header>
      <div className="flex-1 min-h-[420px] relative bg-[var(--color-bg-grain)]">
        <AvatarErrorBoundary>
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--color-fg-muted)] gap-2">
                <span className="thinking-dots">
                  <span />
                  <span />
                  <span />
                </span>
                Загрузка 3D…
              </div>
            }
          >
            <div className="absolute inset-0">
              {vrmExists && vrmSrc && !loadFailed ? (
                <VrmAvatar
                  src={vrmSrc}
                  fill
                  alive={alive}
                  onLoadError={() => setLoadFailed(true)}
                  onLoad={() => setLoadFailed(false)}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="font-display-italic text-[15px] text-[var(--color-fg-ink)]">
                    {loadFailed ? "Не удалось открыть VRM" : "Аватар не загружен"}
                  </p>
                  <Button variant="secondary" size="sm" onClick={onOpenSettings}>
                    Открыть настройки
                  </Button>
                </div>
              )}
            </div>
          </Suspense>
        </AvatarErrorBoundary>
      </div>
    </aside>
  );
}
