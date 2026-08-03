/**
 * Episodes store — Zustand.
 *
 * Holds the list of episodes + the currently-selected episode id.
 * Fetches on mount via ensureDefaultEpisode() (atomic first-episode create).
 */

import { create } from "zustand";
import type { Episode, EpisodeListItem } from "@lia/shared";
import * as api from "../lib/api.js";

function toListItem(ep: Episode, messageCount = 0): EpisodeListItem {
  return { ...ep, messageCount };
}

interface EpisodesState {
  episodes: EpisodeListItem[];
  currentEpisodeId: string | null;
  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  create: (opts?: { title?: string | null }) => Promise<EpisodeListItem | null>;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  /** Delete every episode except the current one. */
  clearOthers: () => Promise<void>;
}

export const useEpisodesStore = create<EpisodesState>((set, get) => ({
  episodes: [],
  currentEpisodeId: null,
  loading: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api.ensureDefaultEpisode();
      // Re-list so we always show the real DB set (not a stale capped snapshot).
      const episodes = await api.listEpisodes();
      set({
        episodes,
        currentEpisodeId:
          result.episodeId ??
          get().currentEpisodeId ??
          episodes[0]?.id ??
          null,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  refresh: async () => {
    try {
      const episodes = await api.listEpisodes();
      set({ episodes });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  create: async (opts) => {
    try {
      const episode = await api.createEpisode(opts);
      const item = toListItem(episode, 0);
      set((s) => ({
        episodes: [item, ...s.episodes.filter((e) => e.id !== item.id)],
        currentEpisodeId: item.id,
        error: null,
      }));
      return item;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  select: (id) => {
    set({ currentEpisodeId: id });
  },

  remove: async (id) => {
    const prev = get().episodes;
    const prevCurrent = get().currentEpisodeId;
    const nextList = prev.filter((e) => e.id !== id);
    const nextCurrent =
      prevCurrent === id ? (nextList[0]?.id ?? null) : prevCurrent;

    // Optimistic only — never full refresh here. Refreshing after delete was
    // pulling hundreds of leftover test rows the UI hadn't shown yet, so the
    // list looked like it "grew" on every delete.
    set({ episodes: nextList, currentEpisodeId: nextCurrent, error: null });

    try {
      await api.deleteEpisode(id);

      if (get().episodes.length === 0) {
        const created = await api.createEpisode({ title: null });
        const item = toListItem(created, 0);
        set({ episodes: [item], currentEpisodeId: item.id, error: null });
      }
    } catch (e) {
      set({ episodes: prev, currentEpisodeId: prevCurrent, error: String(e) });
    }
  },

  clearOthers: async () => {
    const { currentEpisodeId, episodes } = get();
    const keepId = currentEpisodeId ?? episodes[0]?.id ?? null;
    const prev = episodes;
    const kept = keepId ? episodes.filter((e) => e.id === keepId) : [];
    set({ episodes: kept, error: null });

    try {
      const result = await api.clearEpisodes(keepId);
      if (result.episodes.length === 0) {
        const created = await api.createEpisode({ title: null });
        set({
          episodes: [toListItem(created, 0)],
          currentEpisodeId: created.id,
          error: null,
        });
        return;
      }
      set({
        episodes: result.episodes,
        currentEpisodeId: result.keepId ?? result.episodes[0]?.id ?? null,
        error: null,
      });
    } catch (e) {
      set({ episodes: prev, error: String(e) });
    }
  },
}));
