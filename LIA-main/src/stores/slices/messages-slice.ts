// ============================================================================
// Messages slice — сообщения текущего эпизода + эмоции + chat state.
// ============================================================================

import type { StateCreator } from 'zustand';
import type { EmotionVector } from '@/lib/personality';
import type { ChatMessage, ChatMode, AgentWorkspaceModeInput, AgentApplyMode } from './types';
import { INITIAL_EMOTION } from './types';
import type { EpisodesSlice } from './episodes-slice';
import type { AgentSlice } from './agent-slice';
import type { HealthSlice } from './health-slice';
import { deriveEpisodeTitle } from '@/lib/memory/episode-title';
import {
  createEmptyPartsState,
  partsToPlainText,
  reduceAgentParts,
  type AgentPartEvent,
  type MessagePart,
} from '@/lib/agent/message-parts';

export type PendingSandboxConfirm = {
  goal: string;
  workspaceMode: AgentWorkspaceModeInput;
  /** Optimistic user message id to remove on cancel / keep on confirm. */
  userMessageId: string;
  source: 'chat' | 'panel';
  template?: 'general' | 'researcher' | 'coder';
};

/** Ambiguous goal while UI is Agent — confirm chat vs agent run. */
export type PendingAgentRouteConfirm = {
  goal: string;
  workspaceMode: AgentWorkspaceModeInput;
  userMessageId: string;
};

/** First-run shell/packages risk ack before creating an agent task. */
export type PendingShellRiskAck = {
  goal: string;
  workspaceMode: AgentWorkspaceModeInput;
  userMessageId: string;
  source: 'chat' | 'panel' | 'sandbox' | 'route';
  template?: 'general' | 'researcher' | 'coder';
  confirmSandbox?: boolean;
  forceAgent?: boolean;
};

export type MessagesSlice = {
  messages: ChatMessage[];
  /** True when older messages exist beyond the loaded window (cursor pagination). */
  messagesHasMore: boolean;
  messagesLoadingOlder: boolean;
  emotion: EmotionVector;
  isStreaming: boolean;
  mode: ChatMode;
  /** Phase 4: Read / Explore / Edit (auto = infer). */
  agentWorkspaceMode: AgentWorkspaceModeInput;
  /** P3: ask before write vs auto-apply (sticky per session; persisted lightly). */
  agentApplyMode: AgentApplyMode;
  pendingSandboxConfirm: PendingSandboxConfirm | null;
  pendingAgentRouteConfirm: PendingAgentRouteConfirm | null;
  pendingShellRiskAck: PendingShellRiskAck | null;

  setMessages: (msgs: ChatMessage[], opts?: { hasMore?: boolean }) => void;
  prependMessages: (msgs: ChatMessage[], opts?: { hasMore?: boolean }) => void;
  setMessagesLoadingOlder: (v: boolean) => void;
  addMessage: (msg: ChatMessage) => void;
  /** Remove one message and decrement optimistic episode.messageCount. */
  removeMessage: (id: string) => void;
  updateLastMessage: (content: string) => void;
  finalizeLastMessage: () => void;
  setEmotion: (e: EmotionVector) => void;
  setStreaming: (s: boolean) => void;
  setMode: (m: ChatMode) => void;
  setAgentWorkspaceMode: (m: AgentWorkspaceModeInput) => void;
  setAgentApplyMode: (m: AgentApplyMode) => void;
  setPendingSandboxConfirm: (p: PendingSandboxConfirm | null) => void;
  setPendingAgentRouteConfirm: (p: PendingAgentRouteConfirm | null) => void;
  setPendingShellRiskAck: (p: PendingShellRiskAck | null) => void;
  /**
   * Ensure an agent-turn companion message exists for taskId, then reduce event into parts[].
   * Workbench must not write bubble content — only this path.
   */
  applyAgentPartEvent: (taskId: string, event: AgentPartEvent) => void;
  /** Optimistic local patch of agent-turn parts (Apply/undo before SSE). */
  patchAgentTurnParts: (
    taskId: string,
    updater: (parts: MessagePart[]) => MessagePart[],
  ) => void;
};

export const createMessagesSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  MessagesSlice
> = (set) => ({
  messages: [],
  messagesHasMore: false,
  messagesLoadingOlder: false,
  emotion: INITIAL_EMOTION,
  isStreaming: false,
  mode: 'auto',
  agentWorkspaceMode: 'auto',
  agentApplyMode: (typeof window !== 'undefined'
    && window.localStorage?.getItem('lia.agentApplyMode') === 'auto')
    ? 'auto'
    : 'ask',
  pendingSandboxConfirm: null,
  pendingAgentRouteConfirm: null,
  pendingShellRiskAck: null,

  setMessages: (msgs, opts) => set({
    messages: msgs,
    messagesHasMore: opts?.hasMore ?? false,
    messagesLoadingOlder: false,
  }),
  prependMessages: (msgs, opts) => set((s) => {
    const existing = new Set(s.messages.map(m => m.id));
    const novel = msgs.filter(m => !existing.has(m.id));
    if (novel.length === 0 && opts?.hasMore === undefined) return s;
    return {
      messages: [...novel, ...s.messages],
      ...(opts?.hasMore !== undefined ? { messagesHasMore: opts.hasMore } : {}),
    };
  }),
  setMessagesLoadingOlder: (v) => set({ messagesLoadingOlder: v }),
  addMessage: (msg) => set((s) => {
    const preview = truncatePreview(msg.content);
    const episodes = s.currentEpisodeId
      ? s.episodes.map(e => {
          if (e.id !== s.currentEpisodeId) return e;
          const title = e.title
            ?? (msg.role === 'user' ? deriveEpisodeTitle(msg.content) : null)
            ?? e.title;
          return {
            ...e,
            title,
            messageCount: e.messageCount + 1,
            preview: preview || e.preview,
            updatedAt: new Date().toISOString(),
          };
        })
      : s.episodes;
    return { messages: [...s.messages, msg], episodes };
  }),
  removeMessage: (id) => set((s) => {
    if (!s.messages.some(m => m.id === id)) return s;
    const episodes = s.currentEpisodeId
      ? s.episodes.map(e => e.id === s.currentEpisodeId
        ? {
            ...e,
            messageCount: Math.max(0, e.messageCount - 1),
            updatedAt: new Date().toISOString(),
          }
        : e)
      : s.episodes;
    return { messages: s.messages.filter(m => m.id !== id), episodes };
  }),
  updateLastMessage: (content) => set((s) => {
    if (s.messages.length === 0) return s;
    const last = s.messages[s.messages.length - 1];
    if (last.role !== 'companion' || !last.streaming) return s;
    const updated = { ...last, content };
    return { messages: [...s.messages.slice(0, -1), updated] };
  }),
  finalizeLastMessage: () => set((s) => {
    if (s.messages.length === 0) return s;
    const last = s.messages[s.messages.length - 1];
    if (last.role !== 'companion' || !last.streaming) return s;
    const updated = { ...last, streaming: false };
    const preview = truncatePreview(updated.content);
    const episodes = s.currentEpisodeId
      ? s.episodes.map(e => e.id === s.currentEpisodeId
        ? { ...e, preview: preview || e.preview, updatedAt: new Date().toISOString() }
        : e)
      : s.episodes;
    return { messages: [...s.messages.slice(0, -1), updated], episodes };
  }),

  setEmotion: (e) => set({ emotion: e }),
  setStreaming: (s) => set({ isStreaming: s }),
  setMode: (m) => set({ mode: m }),
  setAgentWorkspaceMode: (m) => set({ agentWorkspaceMode: m }),
  setAgentApplyMode: (m) => {
    try {
      if (typeof window !== 'undefined') window.localStorage?.setItem('lia.agentApplyMode', m);
    } catch { /* ignore */ }
    set({ agentApplyMode: m });
  },
  setPendingSandboxConfirm: (p) => set({ pendingSandboxConfirm: p }),
  setPendingAgentRouteConfirm: (p) => set({ pendingAgentRouteConfirm: p }),
  setPendingShellRiskAck: (p) => set({ pendingShellRiskAck: p }),

  applyAgentPartEvent: (taskId, event) => set((s) => {
    const idx = s.messages.findIndex(
      m => m.agentTaskId === taskId && m.role === 'companion',
    );
    const base = idx >= 0
      ? s.messages[idx]
      : {
          id: `agent-turn-${taskId}`,
          role: 'companion' as const,
          content: '',
          createdAt: Date.now(),
          streaming: true,
          agentTaskId: taskId,
          parts: [],
          partsState: createEmptyPartsState(Date.now()),
        };

    const prevState = base.partsState ?? createEmptyPartsState(base.createdAt);
    const nextState = reduceAgentParts(prevState, event);
    const content = partsToPlainText(nextState.parts) || base.content;
    const terminal = event.type === 'task_done'
      || event.type === 'task_failed'
      || event.type === 'task_cancelled';
    const updated: ChatMessage = {
      ...base,
      content,
      parts: nextState.parts,
      partsState: nextState,
      streaming: terminal ? false : true,
      agentTaskId: taskId,
    };

    if (idx >= 0) {
      const messages = s.messages.slice();
      messages[idx] = updated;
      return { messages };
    }
    // New agent-turn bubble
    const preview = truncatePreview(content);
    const episodes = s.currentEpisodeId
      ? s.episodes.map(e => e.id === s.currentEpisodeId
        ? {
            ...e,
            messageCount: e.messageCount + 1,
            preview: preview || e.preview,
            updatedAt: new Date().toISOString(),
          }
        : e)
      : s.episodes;
    return { messages: [...s.messages, updated], episodes };
  }),

  patchAgentTurnParts: (taskId, updater) => set((s) => {
    const idx = s.messages.findIndex(
      m => m.agentTaskId === taskId && m.role === 'companion',
    );
    if (idx < 0) return s;
    const base = s.messages[idx];
    const prevParts = base.parts ?? [];
    const nextParts: MessagePart[] = updater(prevParts);
    const content = partsToPlainText(nextParts) || base.content;
    const messages = s.messages.slice();
    messages[idx] = {
      ...base,
      parts: nextParts,
      content,
      partsState: base.partsState
        ? { ...base.partsState, parts: nextParts }
        : createEmptyPartsState(base.createdAt),
    };
    return { messages };
  }),
});

function truncatePreview(content: string): string | null {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79)}…`;
}
