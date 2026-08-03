/**
 * Chat store — Zustand.
 *
 * Holds messages keyed by episodeId. Streams ChatEvents from the backend
 * into the current episode's message list.
 *
 * Per docs/ARCHITECTURE.md § 9.2 — the store handles 4 event types:
 *   - status    → transient UI badge (not persisted to store)
 *   - text_delta → append to streaming companion message
 *   - done      → finalize streaming message, mark episode as done
 *   - error     → set error, stop streaming
 */

import { create } from "zustand";
import type { ChatEvent, Message } from "@lia/shared";
import * as api from "../lib/api.js";
import { useWorkspaceStore } from "./workspace.js";

interface StreamingState {
  isStreaming: boolean;
  /** Text accumulated so far for the in-flight companion message. */
  streamingText: string;
  /** Transient status label ("Думаю…"). */
  statusLabel: string | null;
  /** Error message if the stream failed. */
  error: string | null;
}

interface ChatState {
  /** Messages per episode (loaded lazily on first open). */
  messagesByEpisode: Record<string, Message[]>;
  streaming: StreamingState;
  /** Abort controller for the in-flight chat request. */
  _abortController: AbortController | null;

  /** Load messages for an episode from the server. */
  loadMessages: (episodeId: string) => Promise<void>;
  /** Send a user message and stream the companion reply. */
  send: (episodeId: string, text: string) => void;
  /** Abort the in-flight chat request. */
  cancel: () => void;
  /** Clear error state. */
  clearError: () => void;
}

const emptyStreaming: StreamingState = {
  isStreaming: false,
  streamingText: "",
  statusLabel: null,
  error: null,
};

export const useChatStore = create<ChatState>((set, get) => ({
  messagesByEpisode: {},
  streaming: { ...emptyStreaming },
  _abortController: null,

  loadMessages: async (episodeId) => {
    // Don't refetch if we already have messages for this episode
    if (get().messagesByEpisode[episodeId]) return;
    try {
      const messages = await api.listMessages(episodeId);
      set((s) => ({
        messagesByEpisode: { ...s.messagesByEpisode, [episodeId]: messages },
      }));
    } catch (e) {
      set({ streaming: { ...get().streaming, error: String(e) } });
    }
  },

  send: (episodeId, text) => {
    if (get().streaming.isStreaming) return;

    // Collect pending attachment ids for this episode
    const pendingIds = useWorkspaceStore.getState().pendingAttachmentIds;

    // Optimistically append the user message to the UI
    const tempUserMsg: Message = {
      id: `temp-user-${Date.now()}`,
      episodeId,
      role: "user",
      content: text,
      attachments: null,
      emotionJson: null,
      tokensIn: null,
      tokensOut: null,
      durationMs: null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    set((s) => ({
      messagesByEpisode: {
        ...s.messagesByEpisode,
        [episodeId]: [...(s.messagesByEpisode[episodeId] ?? []), tempUserMsg],
      },
      streaming: { ...emptyStreaming, isStreaming: true, statusLabel: "Думаю…" },
    }));

    const controller = api.streamChat(
      { text, episodeId, mode: "chat", attachmentIds: pendingIds.length > 0 ? pendingIds : undefined },
      {
        onEvent: (ev: ChatEvent) => {
          switch (ev.type) {
            case "status":
              set((s) => ({ streaming: { ...s.streaming, statusLabel: ev.label } }));
              break;
            case "text_delta":
              set((s) => ({
                streaming: {
                  ...s.streaming,
                  streamingText: s.streaming.streamingText + ev.text,
                  statusLabel: null, // clear "Думаю…" once text starts
                },
              }));
              break;
            case "done": {
              // Promote streaming text to a real companion message
              const streamingText = get().streaming.streamingText;
              const finalMsg: Message = {
                id: `server-${Date.now()}`,
                episodeId,
                role: "companion",
                content: streamingText,
                attachments: null,
                emotionJson: null,
                tokensIn: ev.tokensIn ?? null,
                tokensOut: ev.tokensOut ?? null,
                durationMs: ev.durationMs ?? null,
                createdAt: Math.floor(Date.now() / 1000),
              };
              set((s) => ({
                messagesByEpisode: {
                  ...s.messagesByEpisode,
                  [episodeId]: [...(s.messagesByEpisode[episodeId] ?? []), finalMsg],
                },
                streaming: { ...emptyStreaming },
                _abortController: null,
              }));
              // Clear pending attachments — they're now linked to the message server-side
              useWorkspaceStore.getState().clearPending();
              break;
            }
            case "error":
              set(() => ({
                streaming: { ...emptyStreaming, error: ev.message },
                _abortController: null,
              }));
              break;
            default:
              // tool_start / tool_end — M5 concern
              break;
          }
        },
        onError: (err) => {
          set(() => ({
            streaming: { ...emptyStreaming, error: err.message },
            _abortController: null,
          }));
        },
      },
    );
    set({ _abortController: controller });
  },

  cancel: () => {
    const controller = get()._abortController;
    if (controller) {
      controller.abort();
    }
    // Discard partial streaming text — server may still write a companion
    // message via onStepFinish, but we won't see it; refresh will resync.
    set(() => ({
      streaming: { ...emptyStreaming },
      _abortController: null,
    }));
  },

  clearError: () => {
    set(() => ({ streaming: { ...get().streaming, error: null } }));
  },
}));
