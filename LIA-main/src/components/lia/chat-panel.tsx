'use client';

import dynamic from 'next/dynamic';
import { useChatStore } from '@/stores/chat-store';
import { normalizeChatMode } from '@/lib/chat-modes';
import { useChat } from '@/hooks/use-chat';
import { useAgent } from '@/hooks/use-agent';
import { loadOlderEpisodeMessages } from '@/hooks/use-episodes';
import { ChatMessage } from '@/components/lia/chat-message';
import { ChatInput } from '@/components/lia/chat-input';
import { AgentWorkbench } from '@/components/lia/agent-workbench';
import { AgentStickyBar } from '@/components/lia/agent-sticky-bar';
import { AgentWaitingPrompt } from '@/components/lia/agent-waiting-prompt';
import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { EmptyState } from '@/components/lia/empty-state';
import { WorkspaceBadge } from '@/components/lia/workspace-badge';
import { SandboxConfirmDialog } from '@/components/lia/sandbox-confirm-dialog';
import { AgentRouteConfirmDialog } from '@/components/lia/agent-route-confirm-dialog';
import { AgentShellRiskDialog } from '@/components/lia/agent-shell-risk-dialog';
import { isAgentBusyStatus } from '@/lib/agent/task-status-ui';
import { cn } from '@/lib/utils';
import { ArrowDown, Loader2 } from 'lucide-react';

const CompanionPortrait = dynamic(
  () => import('@/components/lia/companion-portrait').then(m => ({ default: m.CompanionPortrait })),
  { ssr: false },
);

export function ChatPanel({
  companionBeside = false,
  onCycleAvatar,
}: {
  /** Show circular companion face beside Lia's latest reply. */
  companionBeside?: boolean;
  onCycleAvatar?: () => void;
}) {
  const messages = useChatStore(s => s.messages);
  const messagesHasMore = useChatStore(s => s.messagesHasMore);
  const messagesLoadingOlder = useChatStore(s => s.messagesLoadingOlder);
  const episodeId = useChatStore(s => s.currentEpisodeId);
  const isStreaming = useChatStore(s => s.isStreaming);
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const activeTaskStatus = useChatStore(s => s.activeTaskStatus);
  const episodes = useChatStore(s => s.episodes);
  const {
    sendMessage,
    stop,
    pendingAttachments,
    uploadAttachment,
    removePendingAttachment,
    uploading,
    agentCreating,
  } = useChat();
  const { cancel } = useAgent();
  const chatMode = useChatStore(s => s.mode);
  const isAgentMode = normalizeChatMode(chatMode) === 'agent';
  const agentBusy = isAgentBusyStatus(activeTaskStatus);
  const busy = isStreaming || agentBusy || agentCreating;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);

  const isPinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const currentEpisode = episodes.find(e => e.id === episodeId);

  const lastCompanionId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'companion') return messages[i].id;
    }
    return null;
  }, [messages]);

  const stopOrCancel = useCallback(() => {
    if (isStreaming) {
      stop();
      return;
    }
    if (agentBusy && activeTaskId) {
      void cancel(activeTaskId);
    }
  }, [isStreaming, stop, agentBusy, activeTaskId, cancel]);

  useEffect(() => {
    const sentinel = bottomRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const pinned = entries[0]?.isIntersecting ?? true;
        isPinnedToBottomRef.current = pinned;
        setShowJumpToLatest(!pinned && messages.length > 0);
      },
      { root, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [episodeId, messages.length]);

  const scrollToBottom = useCallback(() => {
    if (isPinnedToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    isPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    isPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    loadingOlderRef.current = false;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [episodeId]);

  // Cursor pagination: near top → load older messages, preserve scroll anchor.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const onScroll = () => {
      if (root.scrollTop > 80) return;
      if (!messagesHasMore || loadingOlderRef.current || messagesLoadingOlder) return;
      loadingOlderRef.current = true;
      const prevHeight = root.scrollHeight;
      const prevTop = root.scrollTop;
      void loadOlderEpisodeMessages().then((n) => {
        requestAnimationFrame(() => {
          if (scrollRef.current && n > 0) {
            const el = scrollRef.current;
            el.scrollTop = el.scrollHeight - prevHeight + prevTop;
          }
          loadingOlderRef.current = false;
        });
      }).catch(() => {
        loadingOlderRef.current = false;
      });
    };

    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [episodeId, messagesHasMore, messagesLoadingOlder]);

  const showCompanion = companionBeside && !!onCycleAvatar;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SandboxConfirmDialog />
      <AgentRouteConfirmDialog />
      <AgentShellRiskDialog />
      <div className="min-h-7 border-b border-border shrink-0 bg-surface/50 lia-chat-chrome">
        <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1', 'lia-chat-rail')}>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-xs font-medium truncate text-foreground">
              {currentEpisode?.title || 'Новый чат'}
            </span>
            <WorkspaceBadge episodeId={episodeId} />
            {messages.length > 0 && !isStreaming && !agentBusy && (
              <>
                <span className="text-text-faint">·</span>
                <span className="text-[10px] text-text-dim shrink-0">
                  {messages.length}
                </span>
              </>
            )}
            {isStreaming && (
              <span
                className="inline-flex items-center gap-1.5 text-[10px] text-accent shrink-0"
                role="status"
                aria-live="polite"
              >
                <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />
                <span>Лия отвечает…</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          role="log"
          aria-label="История чата"
        >
          <div className="lia-chat-rail px-5 py-5 space-y-3">
            {messagesLoadingOlder && (
              <div className="flex justify-center py-2 text-text-dim">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Загрузка истории" />
              </div>
            )}
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[min(52vh,28rem)] gap-5">
                {showCompanion && onCycleAvatar && (
                  <CompanionPortrait size="lg" onCycleMode={onCycleAvatar} />
                )}
                <EmptyState needsEpisode={!episodeId} />
              </div>
            ) : (
              messages.map(m => {
                const withFace = showCompanion
                  && m.role === 'companion'
                  && m.id === lastCompanionId
                  && !!onCycleAvatar;

                if (!withFace) {
                  return <ChatMessage key={m.id} message={m} episodeId={episodeId} />;
                }

                return (
                  <div key={m.id} className="flex items-end gap-2.5 max-sm:flex-col max-sm:items-stretch">
                    <CompanionPortrait
                      size="md"
                      onCycleMode={onCycleAvatar}
                      className="mb-5 max-sm:self-start max-sm:mb-0 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <ChatMessage message={m} episodeId={episodeId} />
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} className="h-1" />
          </div>
        </div>

        {showJumpToLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground shadow-md hover:bg-surface-2 transition-colors"
            aria-label="К последним сообщениям"
          >
            <ArrowDown className="w-3 h-3" />
            К последним
          </button>
        )}
      </div>

      <AgentWorkbench />

      <AgentStickyBar />
      {/* Reconnect fallback when ask/permission parts not yet in bubble */}
      <AgentWaitingPrompt />

      <ChatInput
        onSend={(text, mode) => sendMessage(text, mode)}
        isStreaming={busy}
        onStop={stopOrCancel}
        disabled={!episodeId}
        pendingAttachments={pendingAttachments}
        onPickFiles={async files => {
          if (!files) return;
          for (const file of Array.from(files)) {
            await uploadAttachment(file);
          }
        }}
        onRemoveAttachment={removePendingAttachment}
        isAgentMode={isAgentMode}
        uploading={uploading}
        stopLabel={agentBusy && !isStreaming ? 'Остановить агента (Esc)' : undefined}
      />
    </div>
  );
}
