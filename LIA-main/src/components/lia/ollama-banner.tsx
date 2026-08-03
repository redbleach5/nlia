'use client';

import Link from 'next/link';
import { useChatStore } from '@/stores/chat-store';
import { AlertCircle, RefreshCw, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LIA_APP_EVENTS, dispatchLiaAppEvent, onLiaAppEvent } from '@/lib/lia-app-events';

export function OllamaBanner() {
  const ok = useChatStore(s => s.ollamaOk);
  const error = useChatStore(s => s.ollamaError);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = onLiaAppEvent(LIA_APP_EVENTS.settingsChanged, () => {
      setDismissed(false);
    });
    return () => {
      unsub();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, []);

  if (ok === null) return null;
  if (ok) return null;
  if (dismissed) return null;

  const handleRetry = () => {
    if (retrying) return;
    setRetrying(true);
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null;
      setRetrying(false);
    }, 10_000);
    dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
  };

  return (
    <div
      className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex flex-wrap items-center gap-3 text-sm"
      role="status"
      aria-live="polite"
    >
      <AlertCircle className="w-4 h-4 text-warning shrink-0" />
      <span className="text-foreground/90 flex-1 min-w-[12rem]">
        Лия сейчас не может подключиться к своему локальному движку.
        <span className="text-muted-foreground">
          {' '}Открой настройки и проверь, что всё запущено на этом компьютере.
        </span>
        {error && showDetails && (
          <span className="block mt-1 text-xs text-text-dim font-mono">{error}</span>
        )}
      </span>
      <Link
        href="/settings/model"
        className="text-xs text-accent hover:text-accent/80 transition-colors px-2 py-1 rounded hover:bg-surface-2 flex items-center gap-1"
      >
        <Settings className="w-3 h-3" />
        Настройки
      </Link>
      <button
        type="button"
        onClick={handleRetry}
        disabled={retrying}
        className="text-xs text-accent hover:text-accent/80 transition-colors px-2 py-1 rounded hover:bg-surface-2 flex items-center gap-1 disabled:opacity-50"
        aria-label="Повторить проверку подключения"
      >
        <RefreshCw className={retrying ? 'w-3 h-3 animate-spin' : 'w-3 h-3'} />
        {retrying ? 'Проверка…' : 'Повторить'}
      </button>
      {error && (
        <button
          type="button"
          onClick={() => setShowDetails(v => !v)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-surface-2"
        >
          {showDetails ? 'Скрыть подробности' : 'Подробнее'}
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-surface-2"
        aria-label="Скрыть уведомление"
      >
        Скрыть
      </button>
    </div>
  );
}
