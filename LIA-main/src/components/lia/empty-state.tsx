'use client';

// EmptyState — первый вдох: лицо Лии в словах, без IDE-шпаргалки.

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { getModKeyLabel } from '@/lib/utils';
import { LIA_APP_EVENTS, dispatchLiaAppEvent } from '@/lib/lia-app-events';
import { useChatStore } from '@/stores/chat-store';
import { normalizeChatMode } from '@/lib/chat-modes';

const SUGGESTIONS = [
  {
    label: 'Познакомимся',
    text: 'Расскажи немного о себе — чем ты можешь помочь?',
  },
  {
    label: 'Идея',
    text: 'Помоги придумать, с чего начать вечер.',
  },
  {
    label: 'Объясни',
    text: 'Объясни что-нибудь сложное простыми словами.',
  },
] as const;

export function EmptyState({ needsEpisode = false }: { needsEpisode?: boolean }) {
  const [mod, setMod] = useState('Ctrl');
  const mode = useChatStore(s => s.mode);
  const isAgent = normalizeChatMode(mode) === 'agent';

  useEffect(() => {
    setMod(getModKeyLabel());
  }, []);

  useEffect(() => {
    if (needsEpisode) return;
    dispatchLiaAppEvent(LIA_APP_EVENTS.focusComposer);
  }, [needsEpisode]);

  const sendSuggestion = (text: string) => {
    dispatchLiaAppEvent(LIA_APP_EVENTS.suggestion, text);
  };

  return (
    <div className="flex flex-col items-center justify-center text-center px-4 py-2">
      <h2 className="lia-text-xl font-display font-semibold mb-1.5 text-foreground">
        Привет! Я Лия.
      </h2>
      <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
        {needsEpisode
          ? 'Создай чат — и я рядом.'
          : isAgent
            ? 'Режим агента: опиши задачу. Пример ниже — с @file.'
            : 'Напиши мне что угодно. Или выбери начало ниже.'}
      </p>

      {needsEpisode ? (
        <button
          type="button"
          onClick={() => dispatchLiaAppEvent(LIA_APP_EVENTS.newEpisode)}
          className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-xs font-medium text-foreground hover:border-accent hover:bg-accent/5 transition-colors"
          title={`Новый чат (${mod}+N)`}
        >
          <Plus className="w-3.5 h-3.5" />
          Новый чат
        </button>
      ) : isAgent ? (
        <button
          type="button"
          onClick={() => sendSuggestion('@file:src/… почини …')}
          className="mt-5 max-w-md w-full rounded-lg border border-border/80 bg-surface/60 px-3.5 py-2.5 text-left hover:border-accent/50 transition-colors"
        >
          <span className="block text-[11px] text-text-dim mb-1">Пример</span>
          <span className="font-mono text-xs text-sky-300/90">@file:src/… почини …</span>
        </button>
      ) : (
        <div className="mt-5 grid w-full max-w-md grid-cols-3 gap-2 text-left">
          {SUGGESTIONS.map(s => (
            <button
              key={s.label}
              type="button"
              onClick={() => sendSuggestion(s.text)}
              className="lia-onboarding-card !p-3 text-left"
            >
              <span className="block text-xs font-medium text-foreground">{s.label}</span>
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground line-clamp-2">
                {s.text}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
