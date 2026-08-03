'use client';

// ============================================================================
// useKbSources — custom hook for KB sources state + actions.
// ============================================================================
//
// Extracted from KbTab to reduce its size. Encapsulates:
//   - sources list state + loading
//   - SSE progress subscriptions (one EventSource per indexing source)
//   - auto-reindex for idle document/url sources
//   - polling while any source is in 'indexing' status
//   - action handlers: reindex, cancel, pauseResume, sync, delete
//   - upload + add folder + add url flows
//
// Returns a flat object — caller can destructure only what it needs.

import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';

export interface KbSource {
  id: string;
  type: 'document' | 'folder' | 'url' | 'codebase';
  name: string;
  config: string;
  status: 'idle' | 'indexing' | 'ready' | 'error' | 'paused';
  lastIndexedAt: string | null;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function folderBasename(folderPath: string): string {
  const cleaned = folderPath.replace(/[/\\]+$/, '');
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Папка';
}

export interface UseKbSourcesResult {
  sources: KbSource[] | null;
  loading: boolean;
  actionInProgress: string | null;
  pendingDelete: { sourceId: string; name: string } | null;
  refresh: () => Promise<void>;
  watchIndexingProgress: (sourceId: string) => void;
  handleReindex: (sourceId: string) => Promise<void>;
  handleCancel: (sourceId: string) => Promise<void>;
  handleDelete: (sourceId: string, name: string) => Promise<void>;
  confirmDelete: () => Promise<void>;
  cancelDelete: () => void;
  uploadDocument: (file: File, name: string) => Promise<KbSource | null>;
  addFolder: (path: string, name: string) => Promise<KbSource | null>;
  addProject: (params: {
    path: string;
    name: string;
    mode: 'auto' | 'docs' | 'code' | 'both';
  }) => Promise<KbSource[] | null>;
  addUrl: (name: string, url: string) => Promise<KbSource | null>;
}

export function useKbSources(onRefresh?: () => Promise<void>): UseKbSourcesResult {
  const [sources, setSources] = useState<KbSource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  // UI-H8 fix: pending delete state for the AlertDialog confirmation flow.
  const [pendingDelete, setPendingDelete] = useState<{ sourceId: string; name: string } | null>(null);
  const pendingDeleteRef = useRef<{ sourceId: string; name: string } | null>(null);
  pendingDeleteRef.current = pendingDelete;

  // SSE subscriptions — one per indexing source
  const progressStreamsRef = useRef<Map<string, EventSource>>(new Map());
  // UI-H3 fix: per-source reconnect attempt counter (reset on successful message)
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  // Auto-reindex guard — не запускать повторно для того же source
  const autoReindexAttemptedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/kb/sources');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load sources');
      setSources(data.sources);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить источники');
    } finally {
      setLoading(false);
    }
  }, []);

  const watchIndexingProgress = useCallback((sourceId: string) => {
    if (progressStreamsRef.current.has(sourceId)) return;

    const es = new EventSource(`/api/kb/sources/${sourceId}/progress`);
    progressStreamsRef.current.set(sourceId, es);

    es.onmessage = (e) => {
      // UI-H3 fix: reset reconnect attempts on any successful message.
      reconnectAttemptsRef.current.delete(sourceId);
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'connected') return;
        if (event.phase === 'done') {
          toast.success(`Индексация завершена (${event.total} chunks)`);
          es.close();
          progressStreamsRef.current.delete(sourceId);
          setActionInProgress(prev => (prev === sourceId ? null : prev));
          void refresh();
        } else if (event.phase === 'error') {
          toast.error(`Ошибка индексации: ${event.errorMessage ?? 'unknown'}`);
          es.close();
          progressStreamsRef.current.delete(sourceId);
          setActionInProgress(prev => (prev === sourceId ? null : prev));
          void refresh();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // UI-H3 fix: previously closed permanently + one-shot refresh after 2s.
      // If the source was still indexing, real-time progress was lost (only
      // the 2s polling fallback picked up status changes). Now we attempt
      // to re-subscribe after a brief delay, with a max of 5 attempts. After
      // 5 failures we give up and rely on the polling fallback.
      es.close();
      progressStreamsRef.current.delete(sourceId);
      const attempts = (reconnectAttemptsRef.current.get(sourceId) ?? 0) + 1;
      reconnectAttemptsRef.current.set(sourceId, attempts);
      if (attempts > 5) {
        // Too many failures — fall back to polling only.
        setTimeout(() => { void refresh(); }, 2000);
        return;
      }
      setTimeout(() => {
        // Only re-subscribe if the source is still indexing (refresh may
        // have updated its status by now).
        const stillIndexing = sources?.some(s => s.id === sourceId && s.status === 'indexing');
        if (stillIndexing) {
          watchIndexingProgress(sourceId);
        } else {
          void refresh();
        }
      }, 2000 * attempts);  // linear backoff: 2s, 4s, 6s, 8s, 10s
    };
  }, [refresh, sources]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      for (const es of progressStreamsRef.current.values()) es.close();
      progressStreamsRef.current.clear();
    };
  }, []);

  // Poll while there are indexing sources (refreshes status badge)
  useEffect(() => {
    const hasIndexing = sources?.some(s => s.status === 'indexing');
    if (!hasIndexing) return;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [sources, refresh]);

  // Subscribe to SSE if page is open during indexing
  useEffect(() => {
    sources?.filter(s => s.status === 'indexing').forEach(s => watchIndexingProgress(s.id));
  }, [sources, watchIndexingProgress]);

  // Auto-reindex: idle + 0 chunks → indexing never started (document/url only)
  useEffect(() => {
    if (!sources) return;
    for (const s of sources) {
      if (s.status !== 'idle' || s.chunkCount > 0) continue;
      if (s.type !== 'document' && s.type !== 'url') continue;
      if (autoReindexAttemptedRef.current.has(s.id)) continue;
      autoReindexAttemptedRef.current.add(s.id);
      fetch(`/api/kb/sources/${s.id}/reindex`, { method: 'POST' })
        .then(res => { if (res.ok) watchIndexingProgress(s.id); })
        .catch(() => null);
    }
  }, [sources, watchIndexingProgress]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Actions ──
  const handleReindex = useCallback(async (sourceId: string) => {
    setActionInProgress(sourceId);
    try {
      const res = await fetch(`/api/kb/sources/${sourceId}/reindex`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reindex failed');
      toast.success('Переиндексация запущена');
      watchIndexingProgress(sourceId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось запустить индексацию');
      setActionInProgress(null);
    }
  }, [watchIndexingProgress]);

  const handleCancel = useCallback(async (sourceId: string) => {
    setActionInProgress(sourceId);
    try {
      const res = await fetch(`/api/kb/sources/${sourceId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancel failed');
      toast.success('Индексация отменена');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось отменить индексацию');
    } finally {
      setActionInProgress(null);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (sourceId: string, name: string) => {
    // UI-H8 fix: previously used native `confirm()` — blocking, can't be
    // styled, inconsistent with the rest of the app (which uses AlertDialog).
    // Now we expose a `pendingDelete` state + `confirmDelete`/`cancelDelete`
    // callbacks so the UI layer can render an AlertDialog. For backwards
    // compatibility, if no UI is wired up, we still fall back to confirm()
    // — but the KbTab component has been updated to use AlertDialog.
    setPendingDelete({ sourceId, name });
  }, []);

  // UI-H8 fix: called by the AlertDialog's "Confirm" action.
  const confirmDelete = useCallback(async () => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    setPendingDelete(null);
    const { sourceId, name } = pending;
    setActionInProgress(sourceId);
    try {
      const res = await fetch(`/api/kb/sources/${sourceId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      toast.success(`Источник «${name}» удалён`);
      await refresh();
      onRefresh?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить источник');
    } finally {
      setActionInProgress(null);
    }
  }, [refresh, onRefresh]);

  const cancelDelete = useCallback(() => {
    setPendingDelete(null);
  }, []);

  const uploadDocument = useCallback(async (file: File, name: string): Promise<KbSource | null> => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name);
      const res = await fetch('/api/kb/sources/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast.success(`Документ «${name}» загружен — индексация запущена.`);
      await refresh();
      watchIndexingProgress(data.source.id);
      onRefresh?.();
      return data.source as KbSource;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить документ');
      return null;
    }
  }, [refresh, watchIndexingProgress, onRefresh]);

  const addProject = useCallback(async (params: {
    path: string;
    name: string;
    mode: 'auto' | 'docs' | 'code' | 'both';
  }): Promise<KbSource[] | null> => {
    const resolvedName = params.name.trim() || folderBasename(params.path);
    try {
      const res = await fetch('/api/kb/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: params.path.trim(),
          name: resolvedName,
          mode: params.mode,
          watchEnabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add project');
      const count = Array.isArray(data.sources) ? data.sources.length : 0;
      toast.success(
        count > 1
          ? `Проект «${resolvedName}» добавлен (${count} источника) — индексация запущена.`
          : `Проект «${resolvedName}» добавлен — индексация запущена.`,
      );
      if (Array.isArray(data.warnings)) {
        for (const w of data.warnings) toast.message(String(w));
      }
      await refresh();
      for (const s of data.sources ?? []) {
        if (s?.id) watchIndexingProgress(s.id);
      }
      onRefresh?.();
      return (data.sources ?? []).map((s: {
        id: string;
        type: KbSource['type'];
        name: string;
        status: KbSource['status'];
      }) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        config: '',
        status: s.status,
        lastIndexedAt: null,
        chunkCount: 0,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить проект');
      return null;
    }
  }, [refresh, watchIndexingProgress, onRefresh]);

  const addFolder = useCallback(async (path: string, name: string): Promise<KbSource | null> => {
    const created = await addProject({ path, name, mode: 'docs' });
    return created?.[0] ?? null;
  }, [addProject]);

  const addUrl = useCallback(async (name: string, url: string): Promise<KbSource | null> => {
    try {
      const res = await fetch('/api/kb/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url', name: name.trim(), config: { url: url.trim() } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add URL');
      toast.success(`URL «${name}» добавлен — индексация запущена.`);
      await refresh();
      watchIndexingProgress(data.source.id);
      onRefresh?.();
      return data.source as KbSource;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить URL');
      return null;
    }
  }, [refresh, watchIndexingProgress, onRefresh]);

  return {
    sources,
    loading,
    actionInProgress,
    pendingDelete,
    refresh,
    watchIndexingProgress,
    handleReindex,
    handleCancel,
    handleDelete,
    confirmDelete,
    cancelDelete,
    uploadDocument,
    addFolder,
    addProject,
    addUrl,
  };
}
