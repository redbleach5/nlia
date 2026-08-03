'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChatMode, ChatAttachmentMeta } from '@/stores/chat-store';
import { useChatStore } from '@/stores/chat-store';
import { normalizeChatMode } from '@/lib/chat-modes';
import { ChatModeSelector } from '@/components/lia/chat-mode-indicator';
import { AgentWorkspaceModeSelector } from '@/components/lia/agent-workspace-mode-selector';
import { ChatAttachButton, PendingAttachmentChips } from '@/components/lia/chat-attachments';
import { cn } from '@/lib/utils';
import { ArrowUp, Square, File, Folder } from 'lucide-react';
import { cueAvatarGesture, cueAvatarLook } from '@/lib/avatar-cues';
import { LIA_APP_EVENTS, onLiaAppEvent } from '@/lib/lia-app-events';
import { parseMentions } from '@/lib/agent/mentions';

type ChatInputProps = {
  onSend: (text: string, mode: ChatMode) => void;
  isStreaming: boolean;
  onStop: () => void;
  disabled?: boolean;
  pendingAttachments?: ChatAttachmentMeta[];
  onPickFiles?: (files: FileList | null) => void;
  onRemoveAttachment?: (id: string) => void;
  isAgentMode?: boolean;
  uploading?: boolean;
  /** Override stop button tooltip (e.g. agent cancel). */
  stopLabel?: string;
};

type PathEntry = { path: string; kind: 'file' | 'folder' };

const RECENT_KEY = 'lia-mention-recent';

function loadRecent(): PathEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PathEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
}

function pushRecent(entry: PathEntry) {
  try {
    const prev = loadRecent().filter(p => !(p.kind === entry.kind && p.path === entry.path));
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...prev].slice(0, 12)));
  } catch { /* */ }
}

export function ChatInput({
  onSend,
  isStreaming,
  onStop,
  disabled,
  pendingAttachments = [],
  onPickFiles,
  onRemoveAttachment,
  isAgentMode,
  uploading = false,
  stopLabel,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hasSent, setHasSent] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [paths, setPaths] = useState<PathEntry[]>([]);
  const [rulesLabel, setRulesLabel] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mode = useChatStore(s => s.mode);
  const episodeId = useChatStore(s => s.currentEpisodeId);
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const isAgent = normalizeChatMode(mode) === 'agent';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounter = useRef(0);

  const showAttach = !isAgentMode && !!onPickFiles && !!onRemoveAttachment;

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    return onLiaAppEvent(LIA_APP_EVENTS.suggestion, (e) => {
      const suggestion = (e as CustomEvent<string>).detail;
      if (suggestion && typeof suggestion === 'string') {
        setText(suggestion);
        textareaRef.current?.focus();
      }
    });
  }, []);

  useEffect(() => {
    return onLiaAppEvent(LIA_APP_EVENTS.focusComposer, () => {
      if (disabled) return;
      textareaRef.current?.focus();
    });
  }, [disabled]);

  useEffect(() => {
    if (!isStreaming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isStreaming, onStop]);

  // Load workspace paths + rules for agent @ picker / badge.
  useEffect(() => {
    if (!isAgent || !episodeId) {
      setPaths([]);
      setRulesLabel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/episodes/${episodeId}/workspace/probe`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          paths?: PathEntry[];
          rulesSource?: string | null;
          hasRules?: boolean;
        };
        if (cancelled) return;
        setPaths(Array.isArray(data.paths) ? data.paths : []);
        setRulesLabel(data.hasRules && data.rulesSource
          ? `Rules: ${data.rulesSource}`
          : 'без rules');
      } catch {
        if (!cancelled) {
          setPaths([]);
          setRulesLabel('без rules');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isAgent, episodeId, activeTaskId]);

  const mentionCandidates = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    const recent = loadRecent();
    const pool = [
      ...recent,
      ...paths.filter(p => !recent.some(r => r.path === p.path && r.kind === p.kind)),
    ];
    const filtered = q
      ? pool.filter(p => p.path.toLowerCase().includes(q))
      : pool;
    return filtered.slice(0, 10);
  }, [mentionQuery, paths]);

  const closeMention = () => {
    setMentionOpen(false);
    setMentionStart(null);
    setMentionQuery('');
    setMentionIndex(0);
  };

  const insertMention = (entry: PathEntry) => {
    if (mentionStart == null || !textareaRef.current) return;
    const before = text.slice(0, mentionStart);
    const after = text.slice(textareaRef.current.selectionStart);
    const token = `@${entry.kind}:${entry.path} `;
    const next = `${before}${token}${after}`;
    setText(next);
    pushRecent(entry);
    closeMention();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + token.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const updateMentionFromText = (value: string, caret: number) => {
    if (!isAgent) {
      closeMention();
      return;
    }
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) {
      closeMention();
      return;
    }
    const chunk = before.slice(at + 1);
    if (/\s/.test(chunk) || chunk.length > 80) {
      closeMention();
      return;
    }
    // Don't reopen if already a completed @file: path token mid-edit oddly —
    // allow typing query after @ or after @file: / @folder:
    setMentionOpen(true);
    setMentionStart(at);
    setMentionQuery(chunk.replace(/^(file|folder):/i, ''));
    setMentionIndex(0);
  };

  const handleSend = () => {
    const t = text.trim();
    const hasFiles = pendingAttachments.length > 0;
    if ((!t && !hasFiles) || isStreaming || disabled || uploading) return;
    cueAvatarLook('chat', 3.5);
    cueAvatarGesture('nod');
    onSend(t, mode);
    setText('');
    setHasSent(true);
    closeMention();
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (mentionOpen && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isStreaming || disabled || uploading) return;
      e.preventDefault();
      handleSend();
    }
  };

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!showAttach || disabled || isStreaming) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  }, [showAttach, disabled, isStreaming]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!showAttach) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, [showAttach]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!showAttach) return;
    e.preventDefault();
    e.stopPropagation();
  }, [showAttach]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!showAttach || !onPickFiles) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragOver(false);
    if (disabled || isStreaming || uploading) return;
    if (e.dataTransfer.files?.length) onPickFiles(e.dataTransfer.files);
  }, [showAttach, onPickFiles, disabled, isStreaming, uploading]);

  const canSend =
    (!!text.trim() || pendingAttachments.length > 0) &&
    !disabled &&
    !isStreaming &&
    !uploading;
  const showHint = !disabled && (focused || !hasSent || pendingAttachments.length > 0);
  const mentions = isAgent ? parseMentions(text) : [];

  return (
    <div className="border-t border-border/80 bg-background px-5 py-3 shrink-0">
      <div className="lia-chat-rail">
        <div
          className={cn(
            'lia-chat-composer overflow-hidden transition-shadow relative',
            disabled && 'opacity-[0.55]',
            dragOver && 'border-accent/50 ring-2 ring-accent/15',
          )}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-accent/8 pointer-events-none">
              <p className="text-xs font-medium text-accent">Отпусти файлы сюда</p>
            </div>
          )}

          {showAttach && (
            <PendingAttachmentChips
              pending={pendingAttachments}
              episodeId={episodeId}
              onRemove={onRemoveAttachment!}
              disabled={disabled || isStreaming || uploading}
            />
          )}

          {(mentions.length > 0 || (isAgent && rulesLabel)) && (
            <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
              {isAgent && rulesLabel && (
                <span
                  className={cn(
                    'inline-flex items-center rounded px-1.5 py-0.5 text-[10px]',
                    rulesLabel.startsWith('Rules')
                      ? 'bg-emerald-500/10 text-emerald-300/90'
                      : 'bg-surface-2/80 text-text-dim',
                  )}
                  title="Проектные правила из AGENTS.md / .cursorrules"
                >
                  {rulesLabel}
                </span>
              )}
              {mentions.map((m) => (
                <span
                  key={`${m.kind}:${m.path}`}
                  className="inline-flex items-center rounded bg-surface-2/80 px-1.5 py-0.5 text-[10px] font-mono text-sky-300/90"
                >
                  @{m.kind}:{m.path}
                  {m.kind === 'file' && m.lineStart != null ? `#L${m.lineStart}` : ''}
                </span>
              ))}
            </div>
          )}

          {mentionOpen && mentionCandidates.length > 0 && (
            <div
              className="absolute left-2 right-2 bottom-[calc(100%-0.25rem)] z-20 rounded-lg border border-border bg-surface shadow-lg max-h-48 overflow-auto"
              role="listbox"
              aria-label="Упоминания файлов"
            >
              <div className="px-2 py-1 text-[10px] text-text-dim border-b border-border/50">
                Tab/Enter — вставить · можно `#L10-40` после пути
              </div>
              {mentionCandidates.map((c, i) => (
                <button
                  key={`${c.kind}:${c.path}`}
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11px] font-mono',
                    i === mentionIndex ? 'bg-accent/12 text-accent' : 'hover:bg-surface-2/60 text-foreground/90',
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(c);
                  }}
                >
                  {c.kind === 'folder'
                    ? <Folder className="w-3 h-3 shrink-0 opacity-70" />
                    : <File className="w-3 h-3 shrink-0 opacity-70" />}
                  <span className="truncate">@{c.kind}:{c.path}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => {
              const v = e.target.value;
              setText(v);
              updateMentionFromText(v, e.target.selectionStart ?? v.length);
            }}
            onKeyDown={handleKey}
            onFocus={() => {
              setFocused(true);
              cueAvatarLook('composer', 4);
            }}
            onBlur={() => {
              setFocused(false);
              cueAvatarLook('user', 1.2);
              // Delay so option mousedown can fire.
              window.setTimeout(() => closeMention(), 120);
            }}
            placeholder={
              disabled
                ? 'Создай чат, чтобы начать…'
                : isStreaming
                  ? (isAgentMode || isAgent
                    ? 'Агент · Esc — стоп'
                    : 'Лия отвечает · Esc — стоп')
                  : isAgent
                    ? 'Задача… @file: или @folder: · #L10-40'
                    : pendingAttachments.length > 0
                      ? 'Добавь комментарий или отправь…'
                      : 'Сообщение для Лии…'
            }
            disabled={disabled}
            rows={1}
            aria-label="Сообщение для Лии"
            className={cn(
              'w-full resize-none min-h-[44px] max-h-[160px] px-3.5 pt-3 pb-1',
              'bg-transparent text-sm text-foreground placeholder:text-text-dim',
              'focus:outline-none disabled:cursor-not-allowed',
            )}
          />

          <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
            <div className="flex items-center gap-0.5 min-w-0">
              <ChatModeSelector disabled={isStreaming || disabled} />
              {(isAgentMode || isAgent) && (
                <AgentWorkspaceModeSelector disabled={isStreaming || disabled} />
              )}
              {showAttach && (
                <ChatAttachButton
                  onPickFiles={onPickFiles!}
                  disabled={disabled || isStreaming}
                  uploading={uploading}
                />
              )}
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                title={stopLabel ?? 'Остановить (Esc)'}
                aria-label={stopLabel ?? 'Остановить ответ (Esc)'}
                className={cn(
                  'h-8 w-8 shrink-0 rounded-lg flex items-center justify-center transition-colors',
                  'bg-destructive/10 text-destructive hover:bg-destructive/20',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30',
                )}
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                title="Отправить (Enter)"
                aria-label="Отправить сообщение"
                className={cn(
                  'h-8 w-8 shrink-0 rounded-lg flex items-center justify-center transition-all',
                  'bg-accent text-accent-foreground hover:bg-accent/90',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  !canSend && 'opacity-40 cursor-not-allowed',
                )}
              >
                <ArrowUp className="w-4 h-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        {showHint && (
          <p className="mt-2 text-[10px] text-text-dim text-center">
            Enter — отправить · Shift+Enter — новая строка
            {isAgent ? ' · @ — файл/папка' : ''}
            {showAttach ? ' · можно перетащить файл' : ''}
            {isStreaming ? ' · Esc — стоп' : ''}
          </p>
        )}
      </div>
    </div>
  );
}
