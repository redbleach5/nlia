'use client';

import { memo } from 'react';
import type { ChatMessage as ChatMessageType } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './markdown-renderer';
import { MessageAttachmentList } from './chat-attachments';
import { AgentMessageParts } from './agent-message-parts';

// ============================================================================
// ChatMessage — visual hierarchy через lia-msg-* классы
//   • User: справа, тёплый фон, accent border
//   • Companion: слева, neutral surface, мягкая тень
//   • Agent turns: render parts[] only (not parallel workbench text)
// ============================================================================

export const ChatMessage = memo(function ChatMessage({
  message,
  episodeId,
}: {
  message: ChatMessageType;
  episodeId?: string | null;
}) {
  const isUser = message.role === 'user';
  const isStreaming = message.streaming === true;
  const hasParts = !!(message.parts && message.parts.length > 0);

  return (
    <div className={cn('lia-fade-in flex flex-col gap-0.5', isUser ? 'items-end' : 'items-start')}>
      <div className={cn(
        'text-[11px] text-text-dim px-1 font-display',
        isUser ? 'text-right' : 'text-left',
      )}>
        {isUser ? 'Ты' : 'Лия'}
      </div>

      <div
        className={cn(
          isUser ? 'lia-msg-user' : 'lia-msg-companion',
          isStreaming && !hasParts && 'lia-cursor',
          isUser && message.attachments?.length ? 'flex flex-col gap-2' : undefined,
          hasParts ? 'min-w-[min(100%,28rem)] max-w-full' : undefined,
        )}
      >
        {isUser && message.attachments && message.attachments.length > 0 && episodeId && (
          <MessageAttachmentList attachments={message.attachments} episodeId={episodeId} />
        )}
        {hasParts ? (
          <AgentMessageParts
            parts={message.parts!}
            taskId={message.agentTaskId}
            streaming={isStreaming}
          />
        ) : (
          (message.content || isStreaming) && (
            <MessageContent text={message.content} isStreaming={isStreaming} isUser={isUser} />
          )
        )}
      </div>

      {!isStreaming && !isUser && (
        <div className="text-[10px] text-text-faint px-1">
          {new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
});

function MessageContent({ text, isStreaming, isUser }: { text: string; isStreaming: boolean; isUser: boolean }) {
  if (!text && isStreaming) {
    return <span className="text-text-dim italic">думаю…</span>;
  }

  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  return <MarkdownRenderer content={text} />;
}
