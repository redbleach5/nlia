/**
 * Workspace store — Zustand.
 *
 * Holds resources keyed by episodeId + a set of "pending" inline attachment ids
 * that the user has attached to the chat input but not yet sent.
 *
 * Per docs/ARCHITECTURE.md § 6.4 — one workspace panel replaces v2's 5 mechanisms.
 * Resources are episode-scoped (inline attachments + mounted folders) plus
 * global KB resources (episodeId=null).
 */

import { create } from "zustand";
import type { MountResourceRequest, Resource } from "@lia/shared";
import * as api from "../lib/api.js";

interface WorkspaceState {
  /** Resources per episode (loaded lazily on first open). */
  resourcesByEpisode: Record<string, Resource[]>;
  /** Inline attachment ids pending send (not yet attached to a message). */
  pendingAttachmentIds: string[];
  loading: boolean;
  error: string | null;

  /** Load resources for an episode from the server. */
  load: (episodeId: string) => Promise<void>;
  /** Refresh the resource list for an episode. */
  refresh: (episodeId: string) => Promise<void>;
  /** Attach an inline file; adds to pendingAttachmentIds. */
  attachInline: (episodeId: string, file: File) => Promise<Resource | null>;
  /** Mount a folder or codebase. */
  mount: (episodeId: string, req: MountResourceRequest) => Promise<Resource | null>;
  /** Delete a resource. */
  remove: (episodeId: string, id: string) => Promise<void>;
  /** Remove an id from pending attachments (without deleting the resource). */
  removePending: (id: string) => void;
  /** Clear pending attachments after a successful send. */
  clearPending: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  resourcesByEpisode: {},
  pendingAttachmentIds: [],
  loading: false,
  error: null,

  load: async (episodeId) => {
    if (get().resourcesByEpisode[episodeId]) return;
    await get().refresh(episodeId);
  },

  refresh: async (episodeId) => {
    set({ loading: true, error: null });
    try {
      const resources = await api.listResources(episodeId);
      set((s) => ({
        resourcesByEpisode: { ...s.resourcesByEpisode, [episodeId]: resources },
        loading: false,
      }));
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  attachInline: async (episodeId, file) => {
    try {
      const resource = await api.attachInlineResource(episodeId, file);
      set((s) => ({
        resourcesByEpisode: {
          ...s.resourcesByEpisode,
          [episodeId]: [...(s.resourcesByEpisode[episodeId] ?? []), resource],
        },
        pendingAttachmentIds: [...s.pendingAttachmentIds, resource.id],
      }));
      return resource;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  mount: async (episodeId, req) => {
    try {
      const resource = await api.mountResource(episodeId, req);
      set((s) => ({
        resourcesByEpisode: {
          ...s.resourcesByEpisode,
          [episodeId]: [...(s.resourcesByEpisode[episodeId] ?? []), resource],
        },
      }));
      return resource;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  remove: async (episodeId, id) => {
    try {
      await api.deleteResource(id);
      set((s) => ({
        resourcesByEpisode: {
          ...s.resourcesByEpisode,
          [episodeId]: (s.resourcesByEpisode[episodeId] ?? []).filter((r) => r.id !== id),
        },
        pendingAttachmentIds: s.pendingAttachmentIds.filter((pid) => pid !== id),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removePending: (id) => {
    set((s) => ({ pendingAttachmentIds: s.pendingAttachmentIds.filter((pid) => pid !== id) }));
  },

  clearPending: () => {
    set({ pendingAttachmentIds: [] });
  },
}));
