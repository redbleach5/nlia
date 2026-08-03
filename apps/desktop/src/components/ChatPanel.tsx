/**
 * ChatPanel — main chat area. Clay & Cream aesthetic (Anthropic-inspired).
 *
 * Signature elements:
 *   - Newsreader italic serif for the greeting "Привет."
 *   - User bubbles: clay accent, sharp corners
 *   - Companion bubbles: cream surface with hairline border, no shadow
 *   - Thinking indicator: three-dot clay
 *   - Composer: minimal bordered rectangle, clay focus ring (subtle)
 *   - Segmented mode control with editorial labels
 */

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Paperclip,
  Send,
  Square,
  FileText,
  Image as ImageIcon,
  Code,
  Bot,
  User as UserIcon,
  FolderOpen,
  CheckCircle2,
  Circle,
  AlertCircle,
} from "lucide-react";
import { useChatStore } from "../stores/chat.js";
import { useEpisodesStore } from "../stores/episodes.js";
import { useWorkspaceStore } from "../stores/workspace.js";
import { Button } from "./ui/Button.js";
import * as api from "../lib/api.js";
import type { CodingReadiness } from "../lib/api.js";
import type { Resource } from "@lia/shared";

type Mode = "chat" | "code" | "agent";

function mountPathFromResource(r: Resource): string | undefined {
  if (r.kind !== "folder" && r.kind !== "codebase") return undefined;
  const cfg = r.config;
  if ("folderPath" in cfg || "projectPath" in cfg) {
    return cfg.folderPath ?? cfg.projectPath;
  }
  return undefined;
}

export function ChatPanel({ onAgentTaskStart }: { onAgentTaskStart?: (taskId: string) => void }) {
  const currentEpisodeId = useEpisodesStore((s) => s.currentEpisodeId);
  const episodes = useEpisodesStore((s) => s.episodes);
  const messagesByEpisode = useChatStore((s) => s.messagesByEpisode);
  const streaming = useChatStore((s) => s.streaming);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const clearError = useChatStore((s) => s.clearError);

  const resourcesByEpisode = useWorkspaceStore((s) => s.resourcesByEpisode);
  const loadWorkspace = useWorkspaceStore((s) => s.load);
  const pendingAttachmentIds = useWorkspaceStore((s) => s.pendingAttachmentIds);
  const attachInline = useWorkspaceStore((s) => s.attachInline);
  const removePending = useWorkspaceStore((s) => s.removePending);
  const clearPending = useWorkspaceStore((s) => s.clearPending);

  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [setupError, setSetupError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentEpisode = episodes.find((e) => e.id === currentEpisodeId);
  const messages = currentEpisodeId ? messagesByEpisode[currentEpisodeId] ?? [] : [];
  const episodeResources = currentEpisodeId ? resourcesByEpisode[currentEpisodeId] ?? [] : [];
  const pendingAttachments = episodeResources.filter((r) => pendingAttachmentIds.includes(r.id));
  const mounts = episodeResources.filter((r) => r.kind === "folder" || r.kind === "codebase");
  const firstMountPath = mounts.map(mountPathFromResource).find(Boolean);

  useEffect(() => {
    if (currentEpisodeId) void loadMessages(currentEpisodeId);
  }, [currentEpisodeId, loadMessages]);

  useEffect(() => {
    if (currentEpisodeId) void loadWorkspace(currentEpisodeId);
  }, [currentEpisodeId, loadWorkspace]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streaming.streamingText, streaming.statusLabel]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    setSetupError(null);
  }, [mode, firstMountPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || !currentEpisodeId || streaming.isStreaming) return;

    if ((mode === "agent" || mode === "code") && onAgentTaskStart) {
      if (mode === "code" && !firstMountPath) {
        setSetupError("Смонтируйте папку проекта в Workspace (справа), иначе код писать некуда.");
        return;
      }

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episodeId: currentEpisodeId,
            goal: text,
            template: mode === "code" ? "coder" : "general",
            fsScope: firstMountPath || undefined,
            autoStart: true,
          }),
        });
        const body = await res.json();
        if (body.task?.id) onAgentTaskStart(body.task.id);
      } catch (err) {
        console.error("Не удалось запустить агентскую задачу:", err);
      }
      setInput("");
      setSetupError(null);
      return;
    }

    send(currentEpisodeId, text);
    setInput("");
    clearPending();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentEpisodeId) return;
    await attachInline(currentEpisodeId, file);
    e.target.value = "";
  };

  if (!currentEpisodeId) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-fg-muted)]">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center">
            <Bot size={20} className="text-[var(--color-ember)]" />
          </div>
          <div className="space-y-1.5">
            <p className="font-display-italic text-[22px] text-[var(--color-fg-ink)] tracking-tight">
              Здесь будет разговор
            </p>
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Создайте или выберите эпизод, чтобы начать
            </p>
            <p className="text-[11px] text-[var(--color-fg-faint)] editorial-label mt-2">
              используйте панель слева
            </p>
          </div>
        </div>
      </div>
    );
  }

  const showCodingSetup = mode === "code" || mode === "agent";

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-[var(--color-bg)]">
      {/* Header */}
      <header className="h-12 shrink-0 px-6 border-b border-[var(--color-border-soft)] flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[16px] font-medium text-[var(--color-fg-ink)] truncate tracking-tight">
            {currentEpisode?.title || "Новый разговор"}
          </h2>
          <p className="text-[11px] text-[var(--color-fg-faint)] mt-0.5 font-mono">
            {messages.length} сообщ.
            {streaming.isStreaming && " · пишу…"}
            {pendingAttachments.length > 0 && ` · ${pendingAttachments.length} влож.`}
          </p>
        </div>
        {/* Segmented mode control */}
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-[var(--radius-sm)] p-0.5 gap-0.5 border border-[var(--color-border-soft)]">
          <ModeTab active={mode === "chat"} onClick={() => setMode("chat")} title="Обычный диалог">
            Чат
          </ModeTab>
          <ModeTab active={mode === "code"} onClick={() => setMode("code")} title="Режим кода">
            <Code size={11} />
            Код
          </ModeTab>
          <ModeTab active={mode === "agent"} onClick={() => setMode("agent")} title="Агент">
            Агент
          </ModeTab>
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && !streaming.isStreaming && (
            <div className="text-center py-16">
              <p className="font-display-italic text-[40px] font-medium text-[var(--color-fg-ink)] mb-3 tracking-tight leading-none">
                Привет.
              </p>
              <p className="text-[14px] text-[var(--color-fg-muted)] max-w-md mx-auto leading-relaxed">
                {mode === "code"
                  ? "Опишите фичу или модуль — сделаю объёмно: план, несколько файлов, Apply all. Можно @file:path."
                  : mode === "agent"
                  ? "Сформулируйте цель. Для кода лучше режим «Код». Контекст: @file:path"
                  : "О чём поговорим?"}
              </p>
              {showCodingSetup && (
                <div className="mt-8 text-left">
                  <CodingSetupChecklist fsScope={firstMountPath} mounted={Boolean(firstMountPath)} />
                </div>
              )}
            </div>
          )}

          {messages.length > 0 && showCodingSetup && (
            <CodingSetupChecklist fsScope={firstMountPath} mounted={Boolean(firstMountPath)} compact />
          )}

          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              role={m.role}
              content={m.content}
              attachments={m.attachments}
            />
          ))}

          {streaming.isStreaming && (
            <div className="space-y-2 animate-fade-in">
              {streaming.statusLabel && (
                <div className="flex items-center gap-2.5 text-xs text-[var(--color-fg-muted)] italic pl-11 font-display">
                  <span className="thinking-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  {streaming.statusLabel}
                </div>
              )}
              {streaming.streamingText && (
                <MessageBubble role="companion" content={streaming.streamingText} streaming />
              )}
            </div>
          )}

          {streaming.error && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)] p-3.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[var(--color-danger)]">{streaming.error}</p>
                <button
                  onClick={clearError}
                  className="text-[var(--color-danger)] hover:opacity-70 text-xs shrink-0 underline"
                >
                  скрыть
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pending attachments */}
      {pendingAttachments.length > 0 && (
        <div className="px-8 pt-2 max-w-3xl mx-auto w-full">
          <div className="flex flex-wrap gap-1.5">
            {pendingAttachments.map((r) => (
              <AttachmentChip key={r.id} resource={r} onRemove={() => removePending(r.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Composer */}
      <form onSubmit={handleSubmit} className="px-8 py-4 border-t border-[var(--color-border-soft)]">
        <div className="max-w-3xl mx-auto">
          {setupError && (
            <div className="mb-2 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)] px-3 py-2 text-xs text-[var(--color-danger)]">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{setupError}</span>
            </div>
          )}
          {showCodingSetup && (
            <p className="text-[11px] text-[var(--color-fg-faint)] mb-2 px-1 font-mono">
              Порядок: Apply → verify → Commit → Push
            </p>
          )}
          <div className="flex gap-2 items-end rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] focus-within:border-[var(--color-ember)] focus-within:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all px-2.5 py-1.5">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
              accept=".jpg,.jpeg,.png,.webp,.gif,.txt,.md,.csv,.json,.pdf,.docx"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming.isStreaming}
              title="Прикрепить файл"
              aria-label="Прикрепить файл"
            >
              <Paperclip size={15} />
            </Button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "code"
                  ? firstMountPath
                    ? "Сделай модуль X… (можно @folder:src/)"
                    : "Сначала смонтируйте папку в Workspace →"
                  : mode === "agent"
                  ? "Цель… можно @file:path"
                  : "Напишите сообщение…"
              }
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-[var(--color-fg-ink)] placeholder:text-[var(--color-fg-faint)] placeholder:italic focus:outline-none max-h-40"
              style={{ minHeight: "30px" }}
            />
            {streaming.isStreaming ? (
              <Button type="button" variant="danger" size="md" onClick={cancel}>
                <Square size={12} />
                Стоп
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={!input.trim()}
                title="Отправить (Enter)"
                aria-label="Отправить"
              >
                <Send size={13} />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-[var(--color-fg-faint)] mt-2 px-2 font-mono">
            Enter — отправить · Shift+Enter — новая строка
          </p>
        </div>
      </form>
    </div>
  );
}

// ─── Coding setup checklist ─────────────────────────────────────────
function CodingSetupChecklist({
  fsScope,
  mounted,
  compact,
}: {
  fsScope?: string;
  mounted: boolean;
  compact?: boolean;
}) {
  const [readiness, setReadiness] = useState<CodingReadiness | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!fsScope) {
      setReadiness(null);
      return;
    }
    void api.getCodingReadiness(fsScope).then((r) => {
      if (!cancelled) setReadiness(r);
    });
    return () => {
      cancelled = true;
    };
  }, [fsScope]);

  const verifyReady = readiness?.verify.ready ?? false;
  const deployReady = readiness?.deploy.ready ?? false;
  const sshReady = readiness?.ssh.ready ?? false;

  const items: Array<{ ok: boolean; label: string; detail?: string; optional?: boolean }> = [
    {
      ok: mounted,
      label: "Папка смонтирована",
      detail: mounted
        ? fsScope
        : "Workspace справа → смонтировать folder/codebase",
    },
    {
      ok: verifyReady,
      label: "Verify",
      detail: verifyReady
        ? readiness!.verify.commands.join(", ")
        : mounted
          ? "добавьте .lia/verify.json или scripts typecheck/lint/test"
          : "после монтирования",
      optional: true,
    },
    {
      ok: deployReady,
      label: "Deploy",
      detail: deployReady
        ? readiness!.deploy.presets.join(", ")
        : readiness?.deploy.hint ?? ".lia/deploy.json + LIA_ALLOW_DEPLOY=1",
      optional: true,
    },
    {
      ok: sshReady,
      label: "SSH",
      detail: sshReady
        ? `${readiness!.ssh.hosts} host(s)`
        : readiness?.ssh.hint ?? "allowlist + LIA_ALLOW_SSH=1",
      optional: true,
    },
  ];

  if (compact) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border-soft)] bg-[var(--color-surface)]/80 px-3 py-2 text-[11px] font-mono text-[var(--color-fg-muted)] flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="editorial-label text-[var(--color-fg-faint)]">setup</span>
        {items.map((item) => (
          <span
            key={item.label}
            className={item.ok ? "text-[var(--color-success)]" : "text-[var(--color-fg-faint)]"}
            title={item.detail}
          >
            {item.ok ? "✓" : "○"} {item.label}
          </span>
        ))}
        <span className="text-[var(--color-fg-faint)] ml-auto">Apply → verify → Commit</span>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 max-w-md mx-auto">
      <div className="flex items-center gap-2 mb-3">
        <FolderOpen size={14} className="text-[var(--color-ember)]" />
        <p className="editorial-label text-[var(--color-fg-muted)]">Перед стартом</p>
      </div>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-2.5 text-[13px]">
            {item.ok ? (
              <CheckCircle2 size={15} className="text-[var(--color-success)] shrink-0 mt-0.5" />
            ) : (
              <Circle
                size={15}
                className={`shrink-0 mt-0.5 ${item.optional ? "text-[var(--color-fg-faint)]" : "text-[var(--color-ember)]"}`}
              />
            )}
            <div className="min-w-0">
              <p className="text-[var(--color-fg-ink)] font-medium leading-tight">
                {item.label}
                {item.optional && !item.ok && (
                  <span className="text-[var(--color-fg-faint)] font-normal"> · опционально</span>
                )}
              </p>
              {item.detail && (
                <p className="text-[11px] text-[var(--color-fg-muted)] mt-0.5 font-mono truncate" title={item.detail}>
                  {item.detail}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 pt-3 border-t border-[var(--color-border-soft)] text-[11px] text-[var(--color-fg-faint)] font-mono">
        Порядок: Apply → verify → Commit → Push → Deploy
      </p>
    </div>
  );
}

// ─── Mode tab ───────────────────────────────────────────────────────
function ModeTab({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--radius-sm)] text-[12px] font-medium transition-all ${
        active
          ? "bg-[var(--color-surface)] text-[var(--color-ember-deep)] border border-[var(--color-border-soft)]"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg-ink)] border border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Message bubble ─────────────────────────────────────────────────
function MessageBubble({
  role,
  content,
  streaming,
  attachments,
}: {
  role: "user" | "companion" | "assistant" | "system" | "tool";
  content: string;
  streaming?: boolean;
  attachments?: import("@lia/shared").MessageAttachment[] | null;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"} animate-slide-up`}>
      <div
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser
            ? "bg-[var(--color-ember)] text-white"
            : "bg-[var(--color-surface)] text-[var(--color-ember-deep)] border border-[var(--color-border)]"
        }`}
      >
        {isUser ? <UserIcon size={13} /> : <Bot size={13} />}
      </div>
      <div
        className={`max-w-[80%] px-3.5 py-2.5 text-[14px] break-words ${
          isUser
            ? "bg-[var(--color-ember)] text-white rounded-[var(--radius-md)] rounded-tr-[2px]"
            : "bg-[var(--color-surface)] border border-[var(--color-border-soft)] text-[var(--color-fg-ink)] rounded-[var(--radius-md)] rounded-tl-[2px]"
        }`}
      >
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {attachments.map((a) => (
              <span
                key={a.id}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-medium ${
                  isUser
                    ? "bg-white/20 text-white"
                    : "bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border border-[var(--color-border-soft)]"
                }`}
              >
                {a.kind === "image" ? <ImageIcon size={10} /> : <FileText size={10} />}
                {a.name}
              </span>
            ))}
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
        ) : (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {streaming && (
          <span className="inline-block w-1.5 h-4 ml-0.5 bg-[var(--color-ember)] animate-pulse align-middle rounded-sm" />
        )}
      </div>
    </div>
  );
}

// ─── Attachment chip ────────────────────────────────────────────────
function AttachmentChip({ resource, onRemove }: { resource: Resource; onRemove: () => void }) {
  const isImage = (resource.config.mimeType ?? "").startsWith("image/");
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border-soft)] text-[var(--color-fg-ink)]">
      {isImage ? <ImageIcon size={11} /> : <FileText size={11} />}
      <span className="max-w-[160px] truncate">{resource.name}</span>
      <button
        onClick={onRemove}
        className="text-[var(--color-fg-faint)] hover:text-[var(--color-danger)] ml-0.5 leading-none text-base"
        title="Убрать из вложений"
        aria-label="Убрать из вложений"
      >
        ×
      </button>
    </span>
  );
}
