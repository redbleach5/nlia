'use client';

// ============================================================================
// EpisodesSidebar — Companion Workspace pattern
//   • Slimmer (240px вместо 224px — но визуально легче за счет воздуха)
//   • Smart search сверху (filters episodes by title + preview)
//   • Preview последнего сообщения под названием (line-clamp-1)
//   • Группировка по дате (Сегодня/Вчера/На этой неделе/Раньше)
//   • Inline rename (double-click на title)
//   • Active indicator (left accent bar)
//   • Hover delete button
// ============================================================================

import { useChatStore, type Episode } from '@/stores/chat-store';
import { useEpisodes } from '@/hooks/use-episodes';
import { Plus, MessageSquare, Trash2, Search, Pencil } from 'lucide-react';
import { useMemo, useState, useEffect, useRef } from 'react';
import { cn, getModKeyLabel } from '@/lib/utils';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

export function EpisodesSidebar() {
  const episodes = useChatStore(s => s.episodes);
  const currentId = useChatStore(s => s.currentEpisodeId);
  const { create, select, remove, rename } = useEpisodes();

  const [deleteTarget, setDeleteTarget] = useState<Episode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mod, setMod] = useState('Ctrl');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMod(getModKeyLabel()); }, []);

  // Filtered + grouped (title + preview)
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return episodes;
    const q = searchQuery.toLowerCase();
    return episodes.filter(e => {
      const title = (e.title ?? 'Новый чат').toLowerCase();
      const preview = (e.preview ?? '').toLowerCase();
      return title.includes(q) || preview.includes(q);
    });
  }, [episodes, searchQuery]);

  const grouped = useMemo(() => groupEpisodesByPeriod(filtered), [filtered]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleNew = async () => {
    const ep = await create();
    if (ep) {
      await select(ep.id);
    } else {
      // UI-M9 fix: show error toast when create() returns null (network/server error).
      // Previously the user clicked "Новый чат" and nothing happened with no feedback.
      toast.error('Не удалось создать чат');
    }
  };

  // lia-new-episode is handled in useEpisodes (ClientBootstrap) so ⌘N works
  // even when this sidebar is collapsed.

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await remove(deleteTarget.id);
    setDeleteTarget(null);
  };

  const handleStartRename = (ep: Episode) => {
    setRenamingId(ep.id);
    setRenameValue(ep.title ?? '');
  };

  const handleCommitRename = async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      await rename(renamingId, trimmed);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleCancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <aside className="lia-sidebar-episodes w-60 border-r border-border flex flex-col shrink-0 bg-sidebar">
      {/* ─── New chat + search ────────────────────────────────────── */}
      <div className="p-2 border-b border-border space-y-2 shrink-0">
        <button
          onClick={handleNew}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-surface hover:border-accent hover:bg-accent/5 transition-colors text-xs font-medium"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Новый чат</span>
          <kbd className="lia-kbd ml-auto">{mod}+N</kbd>
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск чатов…"
            aria-label="Поиск чатов"
            className="w-full pl-6.5 pr-2 py-1 text-xs rounded-md border border-border bg-surface focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
            style={{ paddingLeft: '1.625rem' }}
          />
        </div>
      </div>

      {/* ─── Episodes list ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-xs text-text-dim text-center">
            {searchQuery ? 'Ничего не найдено' : 'Пока нет чатов. Создай первый.'}
          </div>
        ) : (
          <div className="py-1.5 px-1.5">
            {grouped.map(group => (
              <div key={group.label} className="mb-2">
                <div className="lia-section-label">
                  <span>{group.label}</span>
                  <span className="text-text-faint font-mono normal-case tracking-normal">
                    {group.items.length}
                  </span>
                </div>
                {group.items.map(ep => (
                  <div
                    key={ep.id}
                    onClick={() => renamingId !== ep.id && select(ep.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (renamingId === ep.id) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        select(ep.id);
                      }
                    }}
                    onDoubleClick={() => handleStartRename(ep)}
                    className={cn(
                      'lia-sidebar-item group flex-col items-stretch',
                    )}
                    data-active={currentId === ep.id ? 'true' : 'false'}
                  >
                    <div className="flex items-start gap-2 w-full">
                      <MessageSquare className="w-3 h-3 text-text-dim shrink-0 mt-0.5" />

                      <div className="flex-1 min-w-0">
                        {renamingId === ep.id ? (
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); handleCommitRename(); }
                              if (e.key === 'Escape') { e.preventDefault(); handleCancelRename(); }
                            }}
                            onBlur={handleCommitRename}
                            className="w-full text-xs bg-transparent border-b border-accent outline-none px-0.5 -mx-0.5"
                          />
                        ) : (
                          <div className="lia-sidebar-item-title">
                            {ep.title || 'Новый чат'}
                          </div>
                        )}
                        <div className="lia-sidebar-item-meta mt-0.5">
                          {ep.messageCount} сообщ.
                        </div>
                        {ep.preview && (
                          <div className="lia-sidebar-item-preview">
                            {ep.preview}
                          </div>
                        )}
                      </div>

                      {/* Action buttons (visible on hover) */}
                      {renamingId !== ep.id && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStartRename(ep); }}
                            aria-label={`Переименовать чат ${ep.title || 'Новый чат'}`}
                            className="p-1 rounded text-text-dim hover:text-foreground hover:bg-surface-2 transition-colors"
                            title="Переименовать"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(ep); }}
                            aria-label={`Удалить чат ${ep.title || 'Новый чат'}`}
                            className="p-1 rounded text-text-dim hover:text-destructive hover:bg-surface-2 transition-colors"
                            title="Удалить"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Footer hint ──────────────────────────────────────────── */}
      <div className="border-t border-border px-3 py-1.5 shrink-0">
        <div className="text-[10px] text-text-dim flex items-center gap-2">
          <span>Двойной клик — переименовать</span>
        </div>
      </div>

      {/* ─── Delete confirmation ──────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить чат?</AlertDialogTitle>
            <AlertDialogDescription>
              Чат «{deleteTarget?.title || 'Новый чат'}» будет удалён безвозвратно.
              Все сообщения и связанные воспоминания будут потеряны.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive hover:bg-destructive/90"
            >
              Удалить
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

// ============================================================================
// Grouping
// ============================================================================

type GroupedEpisodes = { label: string; items: Episode[] };

function groupEpisodesByPeriod(episodes: Episode[]): GroupedEpisodes[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const groups: Record<string, Episode[]> = {
    'Сегодня': [],
    'Вчера': [],
    'На этой неделе': [],
    'Раньше': [],
  };

  for (const ep of episodes) {
    const ts = new Date(ep.updatedAt).getTime();
    if (ts >= startOfToday) groups['Сегодня'].push(ep);
    else if (ts >= startOfYesterday) groups['Вчера'].push(ep);
    else if (ts >= startOfWeek) groups['На этой неделе'].push(ep);
    else groups['Раньше'].push(ep);
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}
