// ============================================================================
// Health slice — Ollama health check.
// ============================================================================

import type { StateCreator } from 'zustand';
import type { EpisodesSlice } from './episodes-slice';
import type { MessagesSlice } from './messages-slice';
import type { AgentSlice } from './agent-slice';

export type HealthSlice = {
  ollamaOk: boolean | null;
  ollamaError: string | null;

  setOllamaHealth: (ok: boolean, error?: string | null) => void;
};

export const createHealthSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  HealthSlice
> = (set) => ({
  ollamaOk: null,
  ollamaError: null,

  setOllamaHealth: (ok, error = null) => set({ ollamaOk: ok, ollamaError: error }),
});
