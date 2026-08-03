'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { FolderOpen, BookOpen, Box, X, ChevronDown, Loader2, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceBinding } from '@/lib/agent/workspace-types';
import { toast } from 'sonner';

type KbSourceOption = {
  id: string;
  name: string;
  type: string;
  status: string;
};

type MemoryFact = {
  shortKey: string;
  value: string;
};

type WorkspaceBadgeProps = {
  episodeId: string | null;
  className?: string;
};

export function WorkspaceBadge({ episodeId, className }: WorkspaceBadgeProps) {
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const [envDefault, setEnvDefault] = useState<string | null>(null);
  const [sources, setSources] = useState<KbSourceOption[]>([]);
  const [pinStatus, setPinStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([]);
  const [memoryLabel, setMemoryLabel] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const refreshGenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!episodeId) {
      setBinding(null);
      setPinStatus(null);
      setEnvDefault(null);
      return;
    }
    const gen = ++refreshGenRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/workspace`);
      if (gen !== refreshGenRef.current) return;
      if (!res.ok) {
        setBinding(null);
        setPinStatus(null);
        return;
      }
      const data = await res.json() as { binding: WorkspaceBinding | null; envDefault: string | null };
      if (gen !== refreshGenRef.current) return;
      setBinding(data.binding);
      setEnvDefault(data.envDefault);

      // Phase 6: index status for pinned KB sources
      if (data.binding?.sourceIds?.length) {
        try {
          const srcRes = await fetch('/api/kb/sources');
          if (gen !== refreshGenRef.current) return;
          if (srcRes.ok) {
            const srcData = await srcRes.json() as { sources?: KbSourceOption[] };
            const pinned = (srcData.sources ?? []).filter((s) =>
              data.binding!.sourceIds.includes(s.id),
            );
            const worst =
              pinned.find((s) => s.status === 'error')?.status
              ?? pinned.find((s) => s.status === 'indexing')?.status
              ?? pinned.find((s) => s.status === 'ready')?.status
              ?? pinned[0]?.status
              ?? null;
            if (gen !== refreshGenRef.current) return;
            setPinStatus(worst);
          }
        } catch {
          if (gen === refreshGenRef.current) setPinStatus(null);
        }
      } else {
        setPinStatus(null);
      }
    } catch {
      if (gen !== refreshGenRef.current) return;
      setBinding(null);
      setPinStatus(null);
    } finally {
      if (gen === refreshGenRef.current) setLoading(false);
    }
  }, [episodeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch('/api/kb/sources');
      if (!res.ok) return;
      const data = await res.json() as { sources?: KbSourceOption[] };
      // Show ready + indexing + error (Phase 6) — not only ready
      const usable = (data.sources ?? []).filter((s) =>
        s.status === 'ready' || s.status === 'indexing' || s.status === 'error',
      );
      setSources(usable);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMemory = useCallback(async () => {
    if (!episodeId) return;
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/workspace/memory`);
      if (!res.ok) return;
      const data = await res.json() as {
        facts?: MemoryFact[];
        binding?: { label: string } | null;
      };
      setMemoryFacts(data.facts ?? []);
      setMemoryLabel(data.binding?.label ?? null);
    } catch {
      /* ignore */
    } finally {
      setMemoryLoading(false);
    }
  }, [episodeId]);

  const putBinding = useCallback(async (body: Record<string, unknown> | null) => {
    if (!episodeId) return;
    setBusy(true);
    try {
      if (body === null) {
        const res = await fetch(`/api/episodes/${episodeId}/workspace`, { method: 'DELETE' });
        if (!res.ok) throw new Error('reset failed');
        setBinding(null);
        toast.success('Папка чата отвязана');
        return;
      }
      const res = await fetch(`/api/episodes/${episodeId}/workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { binding?: WorkspaceBinding; error?: string };
      if (!res.ok) throw new Error(data.error || 'save failed');
      setBinding(data.binding ?? null);
      toast.success(data.binding ? `Папка чата: ${data.binding.label}` : 'Сохранено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить папку чата');
    } finally {
      setBusy(false);
    }
  }, [episodeId]);

  const bindFolder = useCallback(async () => {
    if (!episodeId) return;
    setBusy(true);
    try {
      const pick = await fetch('/api/kb/pick-folder');
      const pickData = await pick.json() as { path?: string | null; manual?: boolean; message?: string };
      let path = pickData.path?.trim() || null;
      if (!path && pickData.manual) {
        path = window.prompt(pickData.message || 'Введите путь к папке:')?.trim() || null;
      }
      if (!path) {
        setBusy(false);
        return;
      }
      await putBinding({ kind: 'project', fsPath: path });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось выбрать папку');
      setBusy(false);
    }
  }, [episodeId, putBinding]);

  const bindEnvDefault = useCallback(async () => {
    if (!envDefault) return;
    await putBinding({ kind: 'project', fsPath: envDefault, label: 'Домашний (env)' });
  }, [envDefault, putBinding]);

  const bindKb = useCallback(async (source: KbSourceOption) => {
    await putBinding({
      kind: 'kb',
      sourceIds: [source.id],
      label: source.name,
    });
  }, [putBinding]);

  const bindSandbox = useCallback(async () => {
    await putBinding({ kind: 'sandbox', label: 'Sandbox (черновик)' });
  }, [putBinding]);

  const clearMemory = useCallback(async () => {
    if (!episodeId) return;
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/workspace/memory`, { method: 'DELETE' });
      const data = await res.json() as { facts?: MemoryFact[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'clear failed');
      setMemoryFacts(data.facts ?? []);
      toast.success('Память папки очищена (базовые факты восстановлены)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось очистить');
    } finally {
      setMemoryLoading(false);
    }
  }, [episodeId]);

  if (!episodeId) return null;

  const label = binding?.label
    || (loading ? '…' : 'Папка чата');
  const kindHint = binding
    ? binding.kind === 'project' ? 'диск'
      : binding.kind === 'kb'
        ? (pinStatus === 'indexing' ? 'индекс…'
          : pinStatus === 'error' ? 'ошибка'
            : pinStatus === 'ready' ? 'KB'
              : 'KB')
        : binding.kind === 'sandbox' ? 'черновик'
          : ''
    : 'не выбрана';

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) void loadSources(); }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-1 max-w-[12rem] h-5 px-1.5 rounded-md',
              'text-[10px] border border-border/60 bg-surface/80',
              'hover:border-accent/40 hover:text-foreground text-text-dim',
              'disabled:opacity-60',
              binding && 'text-foreground border-accent/30',
              className,
            )}
            title={binding?.fsPath || binding?.label || 'Папка чата — где Лия работает в этом диалоге'}
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            ) : binding?.kind === 'kb' ? (
              <BookOpen className="w-3 h-3 shrink-0 text-accent" />
            ) : binding?.kind === 'sandbox' ? (
              <Box className="w-3 h-3 shrink-0 text-accent" />
            ) : (
              <FolderOpen className={cn('w-3 h-3 shrink-0', binding && 'text-accent')} />
            )}
            <span className="truncate">{label}</span>
            <span className="text-text-faint shrink-0">· {kindHint}</span>
            <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-72 rounded-xl">
          <DropdownMenuLabel className="text-[11px] text-text-dim font-normal leading-snug">
            {binding
              ? 'Папка чата — куда агент пишет и откуда читает'
              : 'Выбери папку на диске, документ KB или черновик-sandbox'}
          </DropdownMenuLabel>
          <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => void bindFolder()}>
            <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
            Папка на диске…
          </DropdownMenuItem>
          {envDefault && (
            <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => void bindEnvDefault()}>
              <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">Домашняя (из env)</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => void bindSandbox()}>
            <Box className="w-3.5 h-3.5 text-muted-foreground" />
            Черновик (sandbox)
          </DropdownMenuItem>

          {sources.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] text-text-dim font-normal">
                Документ из базы знаний
              </DropdownMenuLabel>
              {sources.slice(0, 12).map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  className="gap-2 cursor-pointer"
                  onSelect={() => void bindKb(s)}
                >
                  <BookOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">{s.name}</span>
                  <span className={cn(
                    'text-[10px] shrink-0',
                    s.status === 'ready' && 'text-success',
                    s.status === 'indexing' && 'text-warning',
                    s.status === 'error' && 'text-destructive',
                    s.status !== 'ready' && s.status !== 'indexing' && s.status !== 'error' && 'text-text-faint',
                  )}>
                    {s.status === 'ready' ? s.type
                      : s.status === 'indexing' ? 'индекс…'
                        : s.status === 'error' ? 'ошибка'
                          : s.type}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          {binding && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 cursor-pointer"
                onSelect={() => {
                  setMemoryOpen(true);
                  void loadMemory();
                }}
              >
                <Brain className="w-3.5 h-3.5 text-muted-foreground" />
                Что Лия помнит о папке…
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                onSelect={() => void putBinding(null)}
              >
                <X className="w-3.5 h-3.5" />
                Отвязать
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={memoryOpen} onOpenChange={setMemoryOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Память папки{memoryLabel ? `: ${memoryLabel}` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Устойчивые факты о проекте — переживают смену чата, если снова
              привязать ту же папку.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-surface/40 px-3 py-2">
            {memoryLoading ? (
              <div className="flex items-center gap-2 text-xs text-text-dim py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Загрузка…
              </div>
            ) : memoryFacts.length === 0 ? (
              <p className="text-xs text-text-dim py-2">Пока пусто — привяжи папку или источник KB.</p>
            ) : (
              <ul className="space-y-1.5">
                {memoryFacts.map((f) => (
                  <li key={f.shortKey} className="text-xs">
                    <span className="font-medium text-foreground">{f.shortKey}</span>
                    <span className="text-text-dim"> — {f.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Закрыть</AlertDialogCancel>
            <AlertDialogAction
              disabled={memoryLoading || memoryFacts.length === 0}
              onClick={(e) => {
                e.preventDefault();
                void clearMemory();
              }}
              className="bg-destructive hover:bg-destructive/90"
            >
              Очистить память
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
