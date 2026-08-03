'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { LIA_APP_EVENTS, onLiaAppEvent } from '@/lib/lia-app-events';

export function useHealth() {
  const setHealth = useChatStore(s => s.setOllamaHealth);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        if (cancelled) return;
        setHealth(data.ok, data.error);
      } catch (e) {
        if (cancelled) return;
        setHealth(false, e instanceof Error ? e.message : String(e));
      }
    };

    check();
    const interval = setInterval(check, 60_000);

    // Re-check health right after Ollama settings change.
    const unsubSettings = onLiaAppEvent(LIA_APP_EVENTS.settingsChanged, () => { check(); });

    // UI-M3 fix: re-check on window focus. Previously a user returning to the
    // tab waited up to 60s for the Ollama banner to update. Now we re-check
    // immediately when the tab becomes visible again.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubSettings();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [setHealth]);
}
