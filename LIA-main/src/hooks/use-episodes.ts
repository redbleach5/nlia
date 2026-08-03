'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, type Episode, type ChatAttachmentMeta, type ChatMessage } from '@/stores/chat-store';
import { abortActiveChatStream } from '@/lib/chat/client-stream-control';
import { LIA_APP_EVENTS, dispatchLiaAppEvent, onLiaAppEvent } from '@/lib/lia-app-events';

function parseClientAttachments(json: string | null): ChatAttachmentMeta[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as ChatAttachmentMeta[];
  } catch {
    return undefined;
  }
}

type ApiMessage = {
  id: string;
  role: string;
  content: string;
  emotionJson: string | null;
  attachmentsJson: string | null;
  createdAt: string;
};

function mapApiMessages(raw: ApiMessage[]): ChatMessage[] {
  return raw.map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'companion',
    content: m.content,
    attachments: parseClientAttachments(m.attachmentsJson),
    createdAt: new Date(m.createdAt).getTime(),
  }));
}

const INITIAL_PAGE_LIMIT = 100;
const OLDER_PAGE_LIMIT = 50;

/** Standalone older-history fetch (usable outside useEpisodes — e.g. ChatPanel). */
export async function loadOlderEpisodeMessages(
  signal?: AbortSignal,
): Promise<number> {
  const state = useChatStore.getState();
  const episodeId = state.currentEpisodeId;
  if (!episodeId || !state.messagesHasMore || state.messagesLoadingOlder) return 0;
  const oldest = state.messages[0];
  if (!oldest) return 0;

  state.setMessagesLoadingOlder(true);
  try {
    const qs = new URLSearchParams({
      limit: String(OLDER_PAGE_LIMIT),
      beforeCreatedAt: new Date(oldest.createdAt).toISOString(),
      beforeId: oldest.id,
    });
    const res = await fetch(`/api/episodes/${episodeId}?${qs}`, { signal });
    if (!res.ok) return 0;
    if (useChatStore.getState().currentEpisodeId !== episodeId) return 0;
    const data = await res.json();
    if (useChatStore.getState().currentEpisodeId !== episodeId) return 0;
    const mapped = mapApiMessages(data.messages ?? []);
    useChatStore.getState().prependMessages(mapped, { hasMore: Boolean(data.hasMore) });
    return mapped.length;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return 0;
    console.error('[useEpisodes] loadOlderEpisodeMessages failed:', e);
    return 0;
  } finally {
    useChatStore.getState().setMessagesLoadingOlder(false);
  }
}

export function useEpisodes() {
  // Use individual selectors — store object changes on every state update,
  // which would re-create callbacks and re-trigger effects.
  const setEpisodes = useChatStore(s => s.setEpisodes);
  const addEpisode = useChatStore(s => s.addEpisode);
  const removeEpisodeFromStore = useChatStore(s => s.removeEpisode);
  const setCurrentEpisode = useChatStore(s => s.setCurrentEpisode);
  const setMessages = useChatStore(s => s.setMessages);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);

  // Keep latest values in refs for use inside callbacks without re-creating them
  const currentEpisodeIdRef = useRef(currentEpisodeId);
  useEffect(() => {
    currentEpisodeIdRef.current = currentEpisodeId;
  }, [currentEpisodeId]);

  // UI-C6 fix: AbortController + latest-request guard for `select`. Previously
  // rapid episode switching (A then B) could land A's messages after B's,
  // leaving the UI showing episode B's title with episode A's messages.
  const selectAbortRef = useRef<AbortController | null>(null);
  const selectTokenRef = useRef(0);
  const olderAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/episodes');
      if (!res.ok) return;
      const data = await res.json();
      setEpisodes(data.episodes ?? []);
    } catch (e) {
      console.error('[useEpisodes] refresh failed:', e);
    }
  }, [setEpisodes]);

  const create = useCallback(async (title?: string): Promise<Episode | null> => {
    try {
      const res = await fetch('/api/episodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const ep = data.episode as Episode;
      addEpisode(ep);
      return ep;
    } catch (e) {
      console.error('[useEpisodes] create failed:', e);
      return null;
    }
  }, [addEpisode]);

  const select = useCallback(async (id: string) => {
    // After F5, persisted currentEpisodeId matches but messages are empty — still load.
    if (
      currentEpisodeIdRef.current === id
      && useChatStore.getState().messages.length > 0
    ) {
      return;
    }

    // Abort in-flight chat stream so reply text/emotion from A cannot land on B.
    abortActiveChatStream();
    olderAbortRef.current?.abort();

    // UI-C6 fix: abort any in-flight select request and increment a token.
    // After the fetch resolves, check that this is still the latest request —
    // if a newer select() was called while we were awaiting, drop our result.
    selectAbortRef.current?.abort();
    const ac = new AbortController();
    selectAbortRef.current = ac;
    const myToken = ++selectTokenRef.current;

    try {
      const res = await fetch(
        `/api/episodes/${id}?limit=${INITIAL_PAGE_LIMIT}`,
        { signal: ac.signal },
      );
      if (!res.ok) return;
      // Superseded by a newer select() call — drop our result.
      if (selectTokenRef.current !== myToken) return;
      const data = await res.json();
      if (selectTokenRef.current !== myToken) return;
      setCurrentEpisode(id);
      setMessages(mapApiMessages(data.messages ?? []), {
        hasMore: Boolean(data.hasMore),
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;  // expected when superseded
      console.error('[useEpisodes] select failed:', e);
    }
  }, [setCurrentEpisode, setMessages]);

  /** Load older messages (scroll-up). Returns how many were prepended. */
  const loadOlderMessages = useCallback(async (): Promise<number> => {
    olderAbortRef.current?.abort();
    const ac = new AbortController();
    olderAbortRef.current = ac;
    return loadOlderEpisodeMessages(ac.signal);
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await fetch(`/api/episodes/${id}`, { method: 'DELETE' });
      removeEpisodeFromStore(id);
      // Check current state to decide what to do next
      const state = useChatStore.getState();
      if (state.currentEpisodeId === null) {
        const remaining = state.episodes.filter(e => e.id !== id);
        if (remaining.length > 0) {
          await select(remaining[0].id);
        } else {
          const ep = await create();
          if (ep) await select(ep.id);
        }
      }
    } catch (e) {
      console.error('[useEpisodes] remove failed:', e);
    }
  }, [removeEpisodeFromStore, select, create]);

  // Rename — PATCH /api/episodes/:id with { title }
  const rename = useCallback(async (id: string, title: string) => {
    try {
      const res = await fetch(`/api/episodes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return;
      // Update episode title in local store
      const state = useChatStore.getState();
      const updated = state.episodes.map(e => e.id === id ? { ...e, title } : e);
      setEpisodes(updated);
    } catch (e) {
      console.error('[useEpisodes] rename failed:', e);
    }
  }, [setEpisodes]);

  // On mount ONLY: ensure default episode exists (atomic on server),
  // then select it. Guard against double-call from HMR/Strict Mode.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        const res = await fetch('/api/episodes/ensure-default', {
          method: 'POST',
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const episodes = (data.episodes ?? []) as Episode[];
        setEpisodes(episodes);

        if (episodes.length > 0 && !useChatStore.getState().currentEpisodeId) {
          await select(episodes[0].id);
        } else if (episodes.length > 0) {
          const savedId = useChatStore.getState().currentEpisodeId;
          if (savedId && episodes.some(e => e.id === savedId)) {
            await select(savedId);
          } else {
            await select(episodes[0].id);
          }
        }
      } catch (e) {
        console.error('[useEpisodes] init failed:', e);
        // Fallback: попробовать GET без блокировки UI навсегда
        try {
          const res = await fetch('/api/episodes', { signal: AbortSignal.timeout(8_000) });
          if (res.ok) {
            const data = await res.json();
            setEpisodes(data.episodes ?? []);
          }
        } catch { /* ignore */ }
      }
    })();
  }, [setEpisodes, select]);

  // Always-mounted listener (ClientBootstrap) so ⌘N / empty-state CTA work
  // even when EpisodesSidebar is collapsed.
  const createRef = useRef(create);
  const selectRef = useRef(select);
  useEffect(() => {
    createRef.current = create;
    selectRef.current = select;
  }, [create, select]);

  useEffect(() => {
    const handler = () => {
      void (async () => {
        const ep = await createRef.current();
        if (ep) {
          await selectRef.current(ep.id);
          dispatchLiaAppEvent(LIA_APP_EVENTS.focusComposer);
        }
      })();
    };
    return onLiaAppEvent(LIA_APP_EVENTS.newEpisode, handler);
  }, []);

  return { refresh, create, select, remove, rename, loadOlderMessages };
}
