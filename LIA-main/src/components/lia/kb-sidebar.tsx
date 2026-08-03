'use client';

// ============================================================================
// KbSidebar — Drawer overlay (Companion Workspace pattern)
//   • Не отбирает место у чата
//   • Открывается из header (⌘B или иконка BookOpen)
//   • Полная функциональность: quick search, sources list, недавно обновлённые источники
//   • SourceDetailModal по клику на результат
// ============================================================================

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Search,
  BookOpen,
  FileText,
  FolderOpen,
  Code2,
  Loader2,
  X,
  Link as LinkIcon,
} from 'lucide-react';
import { cn, getModKeyLabel } from '@/lib/utils';
import { SourceDetailModal } from './source-detail-modal';
import type { SourceType } from '@/lib/kb/types';
import { sourceTypeLabel } from '@/lib/kb/types';
import * as DialogPrimitive from '@radix-ui/react-dialog';

// ============================================================================
// Types
// ============================================================================

interface KbSearchResult {
  id: string;
  sourceId: string;
  content: string;
  sourceName: string | undefined;
  sourceType: string | undefined;
  citation: string | undefined;
  score: number;
  matchType: string;
}

interface KbSource {
  id: string;
  type: SourceType;
  name: string;
  status: string;
  chunkCount: number;
}

interface KbRecentSource {
  id: string;
  name: string;
  type: string;
  status: string;
  chunkCount: number;
  updatedAt: string;
}

// ============================================================================
// Component
// ============================================================================

type KbSidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function KbSidebar({ open, onOpenChange }: KbSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KbSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sources, setSources] = useState<KbSource[]>([]);
  const [recent, setRecent] = useState<KbRecentSource[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [highlightChunkId, setHighlightChunkId] = useState<string | undefined>(undefined);


  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedSourceId(null);
      setHighlightChunkId(undefined);
    }
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  // Load meta on open
  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    try {
      const [sourcesRes, recentRes] = await Promise.all([
        fetch('/api/kb/sources'),
        fetch('/api/kb/recent?limit=10'),
      ]);
      const sourcesData = await sourcesRes.json();
      const recentData = await recentRes.json();
      setSources(sourcesData.sources ?? []);
      setRecent(recentData.recent ?? []);
    } catch {
      // non-fatal
    } finally {
      setLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadMeta();
  }, [open, loadMeta]);

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/kb/search?q=${encodeURIComponent(searchQuery)}&limit=5`);
        const data = await res.json();
        setSearchResults(data.results ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lia-drawer-overlay" />
        <DialogPrimitive.Content asChild aria-describedby={undefined}>
          <aside className="lia-drawer-panel">
        {/* ─── Drawer header ────────────────────────────────────────── */}
        <div className="h-9 border-b border-border flex items-center justify-between px-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="w-3.5 h-3.5 text-accent-2 shrink-0" />
            <DialogPrimitive.Title className="text-xs font-display font-semibold tracking-tight">
              База знаний
            </DialogPrimitive.Title>
            {sources.length > 0 && (
              <span className="text-[10px] text-text-dim font-mono">
                {sources.length}
              </span>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              className="lia-icon-btn"
              title="Закрыть (Esc)"
              aria-label="Закрыть базу знаний"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </DialogPrimitive.Close>
        </div>

        {/* ─── Search ──────────────────────────────────────────────── */}
        <div className="p-3 border-b border-border shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по базе знаний…"
              aria-label="Поиск по базе знаний"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-surface focus:outline-none focus:border-accent-2 focus:ring-2 focus:ring-accent-2/15 transition-colors"
              autoFocus={open}
            />
            {searching && (
              <Loader2 className="w-3 h-3 absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-text-dim" />
            )}
          </div>
          <div className="mt-1.5 text-[10px] text-text-dim font-mono flex items-center gap-1">
            <kbd className="lia-kbd">Esc</kbd>
            <span>— закрыть</span>
          </div>
        </div>

        {/* ─── Content ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {/* Search results (when query non-empty) */}
          {searchQuery.trim() ? (
            <div className="p-2 space-y-1">
              <div className="lia-section-label">
                <span>{searching ? 'Поиск…' : `Результаты (${searchResults.length})`}</span>
              </div>
              {searchResults.length === 0 && !searching && (
                <div className="text-[11px] text-muted-foreground p-3 text-center">
                  Ничего не найдено
                </div>
              )}
              {searchResults.map(r => (
                <button
                  key={r.id}
                  onClick={() => {
                    setSelectedSourceId(r.sourceId);
                    setHighlightChunkId(r.id);
                  }}
                  className="lia-sidebar-item w-full text-left flex-col items-start"
                >
                  <div className="flex items-center gap-1.5 w-full">
                    <SourceTypeIcon type={r.sourceType} />
                    <span className="text-[10px] font-medium text-muted-foreground truncate flex-1">
                      {r.citation ?? r.sourceName ?? 'Источник'}
                    </span>
                    <span className="text-[9px] font-mono text-text-dim">
                      {(r.score * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="text-[11px] line-clamp-3 text-foreground mt-1 leading-snug">
                    {r.content}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <>
              {/* Sources list */}
              <div className="p-2">
                <div className="lia-section-label">
                  <span>Источники ({sources.length})</span>
                </div>
                {loadingMeta ? (
                  <div className="flex justify-center py-3">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-text-dim" />
                  </div>
                ) : sources.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground p-3 leading-relaxed">
                    Нет источников.
                    <br />
                    Добавь через Настройки → База знаний.
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {sources.map(s => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setSelectedSourceId(s.id);
                          setHighlightChunkId(undefined);
                        }}
                        className="lia-sidebar-item w-full text-left"
                      >
                        <SourceTypeIcon type={s.type} />
                        <div className="flex-1 min-w-0">
                          <div className="lia-sidebar-item-title truncate">{s.name}</div>
                          <div className="lia-sidebar-item-meta">
                            {formatSourceMeta(s.chunkCount, s.status)}
                          </div>
                        </div>
                        <StatusDot status={s.status} />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Recently updated sources */}
              {recent.length > 0 && (
                <div className="p-2 border-t border-border">
                  <div className="lia-section-label">
                    <span>Недавно обновлено</span>
                  </div>
                  <div className="space-y-0.5">
                    {recent.map(s => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setSelectedSourceId(s.id);
                          setHighlightChunkId(undefined);
                        }}
                        className="lia-sidebar-item w-full text-left"
                      >
                        <SourceTypeIcon type={s.type} />
                        <div className="flex-1 min-w-0">
                          <div className="lia-sidebar-item-title truncate">{s.name}</div>
                          <div className="lia-sidebar-item-meta">
                            {sourceTypeLabel(s.type)} · {formatRelativeTime(s.updatedAt)}
                          </div>
                        </div>
                        <StatusDot status={s.status} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ─── Drawer footer ───────────────────────────────────────── */}
        <div className="border-t border-border px-3 py-2 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-text-dim">
            Ищет по смыслу и по словам
          </span>
          <kbd className="lia-kbd">{getModKeyLabel()}+B</kbd>
        </div>
          </aside>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {/* Source detail modal */}
      {selectedSourceId && (
        <SourceDetailModal
          sourceId={selectedSourceId}
          highlightChunkId={highlightChunkId}
          onClose={() => {
            setSelectedSourceId(null);
            setHighlightChunkId(undefined);
          }}
        />
      )}
    </DialogPrimitive.Root>
  );
}

// ============================================================================
// Source type icon
// ============================================================================

function SourceTypeIcon({ type }: { type: string | undefined }) {
  if (type === 'url') {
    return <LinkIcon className="w-3 h-3 text-accent-2 shrink-0 mt-0.5" />;
  }
  if (type === 'folder') {
    return <FolderOpen className="w-3 h-3 text-info shrink-0 mt-0.5" />;
  }
  if (type === 'codebase') {
    return <Code2 className="w-3 h-3 text-success shrink-0 mt-0.5" />;
  }
  return <FileText className="w-3 h-3 text-info shrink-0 mt-0.5" />;
}

// ============================================================================
// Status dot
// ============================================================================

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ready: 'bg-emerald-500',
    indexing: 'bg-amber-500 animate-pulse',
    error: 'bg-red-500',
    idle: 'bg-muted-foreground',
    paused: 'bg-muted-foreground/50',
  };
  return (
    <span
      className={cn('lia-status-dot', colors[status] ?? 'bg-muted-foreground')}
      title={sourceStatusLabel(status)}
    />
  );
}

function sourceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    ready: 'Готово',
    indexing: 'Читаю…',
    error: 'Ошибка',
    idle: 'Ожидание',
    paused: 'Пауза',
  };
  return map[status] ?? status;
}

function formatSourceMeta(chunkCount: number, status: string): string {
  const fragments = chunkCount === 1
    ? '1 фрагмент'
    : chunkCount < 5
      ? `${chunkCount} фрагмента`
      : `${chunkCount} фрагментов`;
  return `${fragments} · ${sourceStatusLabel(status)}`;
}

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin}м`;
  if (diffHour < 24) return `${diffHour}ч`;
  if (diffDay < 7) return `${diffDay}д`;
  return date.toLocaleDateString('ru-RU');
}
