'use client';

// Chat hook — wraps the /api/chat streaming endpoint.
//
// Streaming protocol (plain text):
//   - Body is a stream of UTF-8 text chunks
//   - Response headers carry metadata: X-Message-Id, X-Triggers, X-Emotion-B64
//   - Mid-stream failures use LIA_STREAM_ERROR_PREFIX (see stream-error.ts)
//   - No delimiter in body — stream ends when response closes
//
// For agent mode: creates AgentTask via /api/agent; UI updates via useAgentStream.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore, type ChatMessage, type ChatMode, type ChatAttachmentMeta } from '@/stores/chat-store';
import { normalizeChatMode } from '@/lib/chat-modes';
import { classifyAgentRoute, hasAgentWorkIntent } from '@/lib/agent/route-intent';
import { isOpenOrShowArtifactGoal, isFixOrDebugArtifactGoal } from '@/lib/agent/artifact-followup-client';
import { beginChatStream, endChatStream } from '@/lib/chat/client-stream-control';
import { parseStreamErrorPayload } from '@/lib/chat/stream-error';
import { isAgentBusyStatus } from '@/lib/agent/task-status-ui';
import { hasAgentShellRiskAck } from '@/lib/agent/shell-risk-ack';
import { cueAvatarGesture, cueAvatarLook } from '@/lib/avatar-cues';
import { toast } from 'sonner';

export function useChat() {
  const abortRef = useRef<AbortController | null>(null);
  const streamEpisodeIdRef = useRef<string | null>(null);
  const agentCreateInFlightRef = useRef(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [agentCreating, setAgentCreating] = useState(false);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);

  // Pending attachments привязаны к эпизоду загрузки — не тащим в другой чат.
  useEffect(() => {
    setPendingAttachments([]);
  }, [currentEpisodeId]);

  const stillOnStreamEpisode = useCallback(() => {
    const ep = streamEpisodeIdRef.current;
    return ep != null && useChatStore.getState().currentEpisodeId === ep;
  }, []);

  const uploadAttachment = useCallback(async (file: File): Promise<boolean> => {
    const episodeId = useChatStore.getState().currentEpisodeId;
    if (!episodeId) {
      toast.error('Нет активного чата.');
      return false;
    }
    if (pendingAttachments.length >= 5) {
      toast.error('Не больше 5 вложений на сообщение');
      return false;
    }
    const form = new FormData();
    form.append('episodeId', episodeId);
    form.append('file', file);
    setUploading(true);
    try {
      const res = await fetch('/api/chat/attachments', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'Не удалось загрузить файл');
        return false;
      }
      if (data.attachment) {
        setPendingAttachments(prev => {
          if (prev.length >= 5) return prev;
          return [...prev, data.attachment as ChatAttachmentMeta];
        });
      }
      return true;
    } catch {
      toast.error('Не удалось загрузить файл');
      return false;
    } finally {
      setUploading(false);
    }
  }, [pendingAttachments.length]);

  const removePendingAttachment = useCallback(async (id: string) => {
    const episodeId = useChatStore.getState().currentEpisodeId;
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
    if (episodeId) {
      try {
        await fetch(`/api/chat/attachments?id=${encodeURIComponent(id)}&episodeId=${encodeURIComponent(episodeId)}`, {
          method: 'DELETE',
        });
      } catch { /* UI already removed */ }
    }
  }, []);

  const sendMessage = useCallback(async (text: string, mode: ChatMode = 'auto') => {
    // Используем getState() вместо подписки на весь store —
    // это предотвращает ре-рендеры при каждом стриминговом chunk'е.
    const state = useChatStore.getState();
    const episodeId = state.currentEpisodeId;
    if (!episodeId) {
      toast.error('Нет активного чата. Создай новый.');
      return;
    }
    if (state.isStreaming) return;
    if (agentCreateInFlightRef.current) return;

    const trimmed = text.trim();
    const attachmentIds = pendingAttachments.map(a => a.id);
    if (!trimmed && attachmentIds.length === 0) return;

    const openFollowUp = isOpenOrShowArtifactGoal(trimmed);
    const fixFollowUp = isFixOrDebugArtifactGoal(trimmed);
    const softFollowUp = openFollowUp; // open → chat; fix → agent with inherited sandbox

    // Stuck ask_user — free the chat for open/show; cancel so user isn't blocked.
    if (isAgentBusyStatus(state.activeTaskStatus)) {
      if (
        (openFollowUp || fixFollowUp)
        && state.activeTaskStatus === 'waiting_input'
        && state.activeTaskId
      ) {
        try {
          await fetch(`/api/agent/${state.activeTaskId}/cancel`, { method: 'POST' });
        } catch { /* non-fatal */ }
        if (fixFollowUp) {
          // Continue into agent create below after cancel.
        } else {
          // open → fall through to chat
        }
      } else {
        return;
      }
    }
    if (state.pendingSandboxConfirm) {
      toast.info('Сначала подтверди или отмени запись в sandbox.');
      return;
    }
    if (state.pendingAgentRouteConfirm) {
      toast.info('Сначала выбери: диалог или агент.');
      return;
    }
    if (state.pendingShellRiskAck) {
      toast.info('Сначала подтверди предупреждение об агенте.');
      return;
    }

    const uiMode = normalizeChatMode(mode);
    let effectiveMode: ChatMode = uiMode;
    /** API mode for chat pipeline (may be auto when Agent defers to chat). */
    let chatApiMode: ChatMode = uiMode;
    const wantsAutoAgent = uiMode === 'auto' && hasAgentWorkIntent(trimmed);

    if (wantsAutoAgent && !softFollowUp) {
      effectiveMode = 'agent';
    }
    if (openFollowUp && effectiveMode === 'agent') {
      effectiveMode = 'auto';
    }
    // Fix/debug about «игра не работает» stays on agent (needs read/edit tools).
    if (fixFollowUp && uiMode === 'auto') {
      effectiveMode = 'agent';
    }

    // ── AGENT MODE: create agent task instead of streaming chat ──
    if (effectiveMode === 'agent') {
      if (attachmentIds.length > 0) {
        toast.error('Вложения работают только в диалоге. Для файлов проекта — опиши задачу агенту.');
        return;
      }

      // Intent gate: Agent = capability preference, not forced ReAct.
      // Trusted follow-ups / auto-agent heuristics skip the gate.
      const skipGate = fixFollowUp || wantsAutoAgent;
      const route = skipGate ? 'agent' as const : classifyAgentRoute(trimmed);

      if (route === 'chat') {
        // Answer via chat; keep UI mode sticky on Agent.
        effectiveMode = 'auto';
        chatApiMode = 'auto';
      } else if (route === 'ask') {
        const userMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: trimmed,
          createdAt: Date.now(),
        };
        useChatStore.getState().addMessage(userMsg);
        useChatStore.getState().setPendingAgentRouteConfirm({
          goal: trimmed,
          workspaceMode: useChatStore.getState().agentWorkspaceMode,
          userMessageId: userMsg.id,
        });
        return;
      } else {
        agentCreateInFlightRef.current = true;
        setAgentCreating(true);

        // Save user message to UI
        const userMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: trimmed,
          createdAt: Date.now(),
        };
        useChatStore.getState().addMessage(userMsg);

        if (!hasAgentShellRiskAck()) {
          useChatStore.getState().setPendingShellRiskAck({
            goal: trimmed,
            workspaceMode: useChatStore.getState().agentWorkspaceMode,
            userMessageId: userMsg.id,
            source: 'chat',
            forceAgent: skipGate,
          });
          agentCreateInFlightRef.current = false;
          setAgentCreating(false);
          return;
        }

        try {
          const workspaceMode = useChatStore.getState().agentWorkspaceMode;
          const applyMode = useChatStore.getState().agentApplyMode;
          const res = await fetch('/api/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              episodeId,
              goal: trimmed,
              autoStart: true,
              workspaceMode,
              applyMode,
              fsScope: undefined,
              ...(skipGate ? { forceAgent: true } : {}),
            }),
          });
          if (res.status === 409) {
            const err = await res.json().catch(() => ({}));
            if (err.error === 'sandbox_confirm_required') {
              useChatStore.getState().setPendingSandboxConfirm({
                goal: trimmed,
                workspaceMode,
                userMessageId: userMsg.id,
                source: 'chat',
              });
              return;
            }
            if (err.error === 'agent_route_confirm_required') {
              useChatStore.getState().setPendingAgentRouteConfirm({
                goal: trimmed,
                workspaceMode,
                userMessageId: userMsg.id,
              });
              return;
            }
            throw new Error(err.message || err.error || 'HTTP 409');
          }
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'request failed' }));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const data = await res.json();
          if (data.type === 'defer_to_chat') {
            // Server gate: fall through to chat with existing optimistic message.
            // Remove optimistic user msg — chat path will re-add it cleanly.
            useChatStore.getState().removeMessage(userMsg.id);
            effectiveMode = 'auto';
            chatApiMode = 'auto';
            // Continue below into chat pipeline (do not return).
          } else {
            const task = data.task;
            if (task) {
              if (wantsAutoAgent || uiMode === 'agent') {
                useChatStore.getState().setMode('agent');
                if (wantsAutoAgent) {
                  toast.info('Переключилась в режим Агента', {
                    description: 'Многошаговые задачи выполняются с планом и инструментами.',
                  });
                }
              }
              // addAgentTask before setActiveTask so SSE subscribe can read episodeId.
              useChatStore.getState().addAgentTask(task);
              useChatStore.getState().setActiveTask(task.id);
              // Align optimistic user message id with DB if server persisted the goal.
              if (data.userMessageId && typeof data.userMessageId === 'string') {
                useChatStore.setState((s) => ({
                  messages: s.messages.map(m =>
                    m.id === userMsg.id ? { ...m, id: data.userMessageId as string } : m,
                  ),
                }));
              }
            }
            return;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[useChat] agent create failed:', e);
          toast.error(`Не удалось создать задачу: ${msg}`);
          useChatStore.getState().removeMessage(userMsg.id);
          return;
        } finally {
          agentCreateInFlightRef.current = false;
          setAgentCreating(false);
        }
        // defer_to_chat falls through to chat below
      }
    }

    // ── Диалог: streaming chat ──
    // Phase 6.2: используем crypto.randomUUID() вместо Date.now() для уникальности.
    // Date.now() мог дать одинаковые ID при быстрых сообщениях (разница <1ms).
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      attachments: attachmentIds.length > 0 ? [...pendingAttachments] : undefined,
      createdAt: Date.now(),
    };
    const liaMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'companion',
      content: '',
      streaming: true,
      createdAt: Date.now() + 1,
    };
    useChatStore.getState().addMessage(userMsg);
    useChatStore.getState().addMessage(liaMsg);
    useChatStore.getState().setStreaming(true);
    cueAvatarLook('chat', 4);
    cueAvatarGesture('acknowledge');

    const ac = new AbortController();
    abortRef.current = ac;
    streamEpisodeIdRef.current = episodeId;
    beginChatStream(episodeId, ac);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          episodeId,
          mode: chatApiMode,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        }),
        signal: ac.signal,
      });

      // Специальная обработка 503 — Ollama недоступен или нет моделей.
      // Сервер возвращает понятное сообщение — показываем его без технических деталей.
      if (res.status === 503) {
        const err = await res.json().catch(() => ({ error: 'Ollama недоступен' }));
        throw new Error(err.error || 'Ollama недоступен');
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // ── AUTO-AGENT ROUTING detection ──
      // Если сервер вернул JSON с type='agent_task' — это auto-routing в agent mode.
      // Сервер уже создал task, нам нужно подписаться на SSE.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.type === 'agent_task' && data.taskId) {
          if (!stillOnStreamEpisode()) return;
          useChatStore.getState().setMode('agent');
          // Удаляем placeholder lia message (он пустой, не нужен)
          useChatStore.getState().removeMessage(liaMsg.id);
          // Align optimistic user message with DB id when server persisted the goal.
          if (data.userMessageId && typeof data.userMessageId === 'string') {
            useChatStore.setState((s) => ({
              messages: s.messages.map(m =>
                m.id === userMsg.id ? { ...m, id: data.userMessageId as string } : m,
              ),
            }));
          }

          // Подписываемся на agent task SSE — hydrate task (with episodeId) first.
          try {
            const taskRes = await fetch(`/api/agent/${data.taskId}`);
            if (taskRes.ok) {
              const taskData = await taskRes.json();
              if (taskData.task) {
                useChatStore.getState().addAgentTask(taskData.task);
              }
            }
          } catch { /* non-fatal */ }
          useChatStore.getState().setActiveTask(data.taskId);

          // Progress stays in the right panel; the final answer lands in chat via SSE.
          return;
        }
      }

      if (!res.body) {
        throw new Error('no response body');
      }

      // Read emotion + metadata from headers.
      // Заголовки с суффиксом -B64 закодированы в base64 (non-ASCII: русский текст, JSON).
      // Остальные — plain ASCII, читаются как есть.
      const decodeB64 = (s: string | null): string | null => {
        if (!s) return null;
        try {
          const binary = atob(s);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        } catch {
          return s;
        }
      };

      if (stillOnStreamEpisode()) {
        const emotionHeader = decodeB64(res.headers.get('X-Emotion-B64'));
        if (emotionHeader) {
          try {
            const emotion = JSON.parse(emotionHeader);
            useChatStore.getState().setEmotion(emotion);
          } catch { /* ignore */ }
        }

        // Align optimistic user id with DB id from the stream response.
        const serverUserMsgId = res.headers.get('X-Message-Id');
        if (serverUserMsgId) {
          useChatStore.setState((s) => ({
            messages: s.messages.map(m =>
              m.id === userMsg.id ? { ...m, id: serverUserMsgId } : m,
            ),
          }));
        }
      }

      // Dev metadata from stream headers (tier / cognitive plan / disagreement).
      if (process.env.NODE_ENV !== 'production') {
        const meta = {
          tier: res.headers.get('X-Tier'),
          complexity: res.headers.get('X-Complexity'),
          mode: res.headers.get('X-Mode'),
          calls: res.headers.get('X-Calls'),
          deliberate: res.headers.get('X-Deliberate'),
          selfCheck: res.headers.get('X-SelfCheck'),
          disagreement: decodeB64(res.headers.get('X-Disagreement-B64')),
        };
        if (meta.tier || meta.disagreement) {
          console.warn(
            `[chat] tier=${meta.tier} complexity=${meta.complexity} mode=${meta.mode} ` +
            `disagreement=${meta.disagreement} deliberate=${meta.deliberate} selfCheck=${meta.selfCheck}`,
          );
        }
      }

      // Stream text chunks
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        if (stillOnStreamEpisode()) {
          useChatStore.getState().updateLastMessage(accumulated);
        }
      }

      if (!stillOnStreamEpisode()) return;

      const streamErr = parseStreamErrorPayload(accumulated);
      if (streamErr) {
        if (streamErr.partial) {
          useChatStore.getState().updateLastMessage(streamErr.partial);
          useChatStore.getState().finalizeLastMessage();
        } else {
          useChatStore.getState().removeMessage(liaMsg.id);
        }
        toast.error(streamErr.error);
        return;
      }

      useChatStore.getState().updateLastMessage(accumulated);
      useChatStore.getState().finalizeLastMessage();
      setPendingAttachments([]);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // Switch/stop — only finalize if still on the stream's episode.
        if (stillOnStreamEpisode()) {
          useChatStore.getState().finalizeLastMessage();
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useChat] error:', e);

        if (!stillOnStreamEpisode()) {
          toast.error(msg);
          return;
        }

        // Если стрим ещё не начался (liaMsg пустой) — удаляем оба сообщения
        // (user + placeholder lia), чтобы не засорять чат ошибочными попытками.
        const cur = useChatStore.getState();
        const lastMsg = cur.messages[cur.messages.length - 1];
        if (lastMsg && lastMsg.role === 'companion' && lastMsg.streaming && !lastMsg.content) {
          // UI-M19 fix: delete by ID (userMsg.id + liaMsg.id) instead of
          // `slice(0, -2)`. If the store was mutated between addMessage and
          // this error (e.g., another message arrived), slice(0, -2) would
          // remove the wrong pair. Filtering by ID is robust.
          useChatStore.getState().removeMessage(userMsg.id);
          useChatStore.getState().removeMessage(liaMsg.id);
          toast.error(msg);
        } else {
          // Стрим уже начался — показываем частичный ответ, ошибку — toast.
          toast.error(`Не удалось отправить: ${msg}`);
          useChatStore.getState().finalizeLastMessage();
        }
      }
    } finally {
      endChatStream(ac);
      if (abortRef.current === ac) abortRef.current = null;
      streamEpisodeIdRef.current = null;
      useChatStore.getState().setStreaming(false);
      cueAvatarLook('user', 1.5);
    }
  }, [pendingAttachments, stillOnStreamEpisode]);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  return {
    sendMessage,
    stop,
    pendingAttachments,
    uploadAttachment,
    removePendingAttachment,
    uploading,
    agentCreating,
  };
}
