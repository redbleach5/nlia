'use client';

import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { useAgent } from '@/hooks/use-agent';
import { AlertCircle, Loader2 } from 'lucide-react';

/**
 * Fallback ask UI when the agent bubble does not yet carry an `ask` part
 * (e.g. reconnect before parts hydrate). Prefer inline AskCard in the bubble.
 */
export function AgentWaitingPrompt() {
  const status = useChatStore(s => s.activeTaskStatus);
  const question = useChatStore(s => s.activeTaskQuestion);
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const messages = useChatStore(s => s.messages);
  const { provideInput } = useAgent();
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const bubbleHandlesAsk = Boolean(
    activeTaskId
    && messages.some(
      m =>
        m.agentTaskId === activeTaskId
        && m.parts?.some(p => p.type === 'ask' || p.type === 'permission_request'),
    ),
  );

  useEffect(() => {
    if (status !== 'waiting_input' || !question || bubbleHandlesAsk) return;
    textareaRef.current?.focus();
  }, [status, question, activeTaskId, bubbleHandlesAsk]);

  if (bubbleHandlesAsk) return null;
  if (status !== 'waiting_input' || !question || !activeTaskId) return null;

  const handleSubmit = async () => {
    const text = answer.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const ok = await provideInput(activeTaskId, text);
      if (ok) setAnswer('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pointer-events-auto mx-3 mb-2 rounded-xl border border-warning/40 bg-warning/8 backdrop-blur-sm p-3 shadow-lg lia-bubble-enter">
      <div className="flex items-center gap-1.5 mb-2">
        <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-[10px] font-medium tracking-wide text-warning">
          Вопрос
        </span>
      </div>
      <p className="text-xs text-foreground/90 leading-relaxed mb-2">{question}</p>
      <textarea
        ref={textareaRef}
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        disabled={submitting}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder="Твой ответ…"
        rows={2}
        aria-label="Ответ агенту"
        className="w-full text-xs px-2.5 py-2 rounded-lg border border-border/70 bg-background/90 placeholder:text-text-dim focus:outline-none focus:border-accent resize-none disabled:opacity-60"
      />
      <div className="flex justify-end mt-2">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!answer.trim() || submitting}
          className="px-3 py-1.5 text-[11px] rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
        >
          {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
          {submitting ? 'Отправка…' : 'Ответить'}
        </button>
      </div>
    </div>
  );
}
