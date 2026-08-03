// ============================================================================
// Episodes slice — список эпизодов + текущий выбранный.
// ============================================================================

import type { StateCreator } from 'zustand';
import type { Episode } from './types';
// Forward declarations для cross-slice type dependencies.
// MessagesSlice нужен потому что setCurrentEpisode сбрасывает messages.
import type { MessagesSlice } from './messages-slice';
import type { AgentSlice } from './agent-slice';
import type { HealthSlice } from './health-slice';

export type EpisodesSlice = {
  episodes: Episode[];
  currentEpisodeId: string | null;

  setEpisodes: (eps: Episode[]) => void;
  addEpisode: (ep: Episode) => void;
  removeEpisode: (id: string) => void;
  setCurrentEpisode: (id: string | null) => void;
};

export const createEpisodesSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  EpisodesSlice
> = (set) => ({
  episodes: [],
  currentEpisodeId: null,

  setEpisodes: (eps) => set({ episodes: eps }),
  addEpisode: (ep) => set((s) => ({ episodes: [ep, ...s.episodes] })),
  removeEpisode: (id) => set((s) => ({
    episodes: s.episodes.filter(e => e.id !== id),
    currentEpisodeId: s.currentEpisodeId === id ? null : s.currentEpisodeId,
  })),
  // setCurrentEpisode сбрасывает messages.
  // Same-episode re-select (F5): keep activeTaskId so SSE can rehydrate result.
  // Different episode: clear active agent so UI does not leak across chats.
  setCurrentEpisode: (id) => set((s) => {
    const sameEpisode = s.currentEpisodeId === id && id != null;
    return {
      currentEpisodeId: id,
      messages: [],
      messagesHasMore: false,
      messagesLoadingOlder: false,
      pendingSandboxConfirm: null,
      pendingAgentRouteConfirm: null,
      pendingShellRiskAck: null,
      activeTaskId: sameEpisode ? s.activeTaskId : null,
      activeTaskStatus: sameEpisode ? s.activeTaskStatus : null,
      activeTaskPlan: null,
      activeTaskSteps: [],
      activeTaskQuestion: null,
      activeTaskResult: null,
      activeTaskError: null,
      activeTaskArtifacts: [],
      activeTaskFileChanges: [],
      activeTaskDesign: null,
      activeTaskRuntimeLogs: [],
      activeTaskRuntime: null,
    };
  }),
});
