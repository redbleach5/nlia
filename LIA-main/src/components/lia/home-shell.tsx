'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, useCallback, useRef } from 'react';
import { ClientBootstrap } from '@/components/lia/client-bootstrap';
import { HeaderStatus } from '@/components/lia/header-status';
import { OllamaBanner } from '@/components/lia/ollama-banner';
import { SettingsLink } from '@/components/lia/settings-link';
import { KbSidebar } from '@/components/lia/kb-sidebar';
import { ShortcutsHelp } from '@/components/lia/shortcuts-help';
import { PanelErrorBoundary } from '@/components/lia/panel-error-boundary';
import { LIA_APP_EVENTS, dispatchLiaAppEvent, onLiaAppEvent } from '@/lib/lia-app-events';
import { useChatStore } from '@/stores/chat-store';
import { normalizeChatMode } from '@/lib/chat-modes';
import { useRouter } from 'next/navigation';

const EpisodesSidebar = dynamic(
  () => import('@/components/lia/episodes-sidebar').then(m => ({ default: m.EpisodesSidebar })),
  {
    ssr: false,
    loading: () => (
      <aside className="lia-sidebar-episodes w-60 shrink-0 border-r border-border bg-surface/40 p-3 space-y-2" aria-hidden>
        <div className="h-7 rounded-md bg-surface-2 animate-pulse" />
        <div className="h-8 rounded-md bg-surface-2/80 animate-pulse" />
        <div className="h-8 rounded-md bg-surface-2/60 animate-pulse" />
        <div className="h-8 rounded-md bg-surface-2/40 animate-pulse" />
      </aside>
    ),
  },
);

const ChatPanel = dynamic(
  () => import('@/components/lia/chat-panel').then(m => ({ default: m.ChatPanel })),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center text-sm text-text-dim">
        Загрузка чата…
      </div>
    ),
  },
);

const AvatarColumn = dynamic(
  () => import('@/components/lia/avatar-column').then(m => ({ default: m.AvatarColumn })),
  {
    ssr: false,
    loading: () => (
      <aside className="lia-avatar-col-full shrink-0 border-l border-border bg-surface/30 p-4" aria-hidden>
        <div className="h-full min-h-[12rem] rounded-xl bg-surface-2/50 animate-pulse" />
      </aside>
    ),
  },
);

// ============================================================================
// AvatarMode — 3 состояния аватара:
//   full     — колонка PresenceStage справа
//   portrait — кружок CompanionPortrait у сообщений (не отдельная колонка)
//   hidden   — без presence
// ============================================================================
type AvatarMode = 'full' | 'portrait' | 'hidden';

const AVATAR_MODE_KEY = 'lia-avatar-mode';
const NARROW_MQ = '(max-width: 1200px)';

function getInitialAvatarMode(): AvatarMode {
  try {
    const saved = localStorage.getItem(AVATAR_MODE_KEY);
    if (saved === 'hero') return 'full';
    if (saved === 'portrait' || saved === 'hidden' || saved === 'full') return saved;
  } catch { /* */ }
  return 'full';
}

// ============================================================================
// HomeShell — Companion Workspace layout
//   • Slim header 36px
//   • Main: EpisodesSidebar | Chat(+ companion portrait) | FullAvatar(right)
//   • KB drawer overlay
//   • <1200px: auto-collapse episodes + prefer portrait over full
// ============================================================================
export function HomeShell() {
  const router = useRouter();
  // Always start with SSR-safe defaults — restore from localStorage after mount
  // so the first client render matches the server HTML (no hydration mismatch).
  const [avatarMode, setAvatarMode] = useState<AvatarMode>('full');
  const [prefsReady, setPrefsReady] = useState(false);
  const [episodesCollapsed, setEpisodesCollapsed] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const userCollapsedRef = useRef(false);
  const narrowAppliedRef = useRef(false);
  const demotedFromFullRef = useRef(false);

  useEffect(() => {
    setAvatarMode(getInitialAvatarMode());
    setPrefsReady(true);
  }, []);

  useEffect(() => {
    if (!prefsReady) return;
    try { localStorage.setItem(AVATAR_MODE_KEY, avatarMode); } catch { /* */ }
  }, [avatarMode, prefsReady]);

  // Desktop narrow: collapse episodes and demote full → portrait; restore on widen
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const apply = () => {
      if (mq.matches) {
        narrowAppliedRef.current = true;
        if (!userCollapsedRef.current) setEpisodesCollapsed(true);
        setAvatarMode(prev => {
          if (prev === 'full') {
            demotedFromFullRef.current = true;
            return 'portrait';
          }
          return prev;
        });
      } else if (narrowAppliedRef.current) {
        narrowAppliedRef.current = false;
        if (!userCollapsedRef.current) setEpisodesCollapsed(false);
        if (demotedFromFullRef.current) {
          demotedFromFullRef.current = false;
          setAvatarMode('full');
        }
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const toggleEpisodes = useCallback(() => {
    setEpisodesCollapsed(prev => {
      const next = !prev;
      userCollapsedRef.current = next;
      return next;
    });
  }, []);

  const toggleKb = useCallback(() => {
    setKbOpen(p => !p);
  }, []);

  const cycleAvatarMode = useCallback(() => {
    setAvatarMode(prev => prev === 'full' ? 'portrait' : prev === 'portrait' ? 'hidden' : 'full');
    demotedFromFullRef.current = false;
  }, []);

  const handleHotkeys = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const inEditable = tag === 'input' || tag === 'textarea' || target?.isContentEditable;

    if (!inEditable && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setShortcutsOpen(prev => !prev);
      return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    if (e.key === '\\') {
      if (inEditable) return;
      e.preventDefault();
      toggleEpisodes();
    } else if (e.key === 'b' || e.key === 'B') {
      if (inEditable) return;
      e.preventDefault();
      toggleKb();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      dispatchLiaAppEvent(LIA_APP_EVENTS.newEpisode);
    } else if (e.key === ',') {
      if (inEditable) return;
      e.preventDefault();
      router.push('/settings/model');
    } else if ((e.key === 'a' || e.key === 'A') && e.shiftKey) {
      if (inEditable) return;
      // In agent mode Ctrl+Shift+A toggles Apply ask|auto (AgentWorkspaceModeSelector).
      if (normalizeChatMode(useChatStore.getState().mode) === 'agent') return;
      e.preventDefault();
      cycleAvatarMode();
    }
  }, [toggleEpisodes, toggleKb, cycleAvatarMode, router]);

  useEffect(() => {
    window.addEventListener('keydown', handleHotkeys);
    return () => window.removeEventListener('keydown', handleHotkeys);
  }, [handleHotkeys]);

  useEffect(() => {
    const openKb = () => setKbOpen(true);
    return onLiaAppEvent(LIA_APP_EVENTS.openKb, openKb);
  }, []);

  // Legacy openSettings event → full settings page
  useEffect(() => {
    return onLiaAppEvent(LIA_APP_EVENTS.openSettings, () => {
      router.push('/settings/model');
    });
  }, [router]);

  // Clear legacy focus-mode flag if present
  useEffect(() => {
    try { localStorage.removeItem('lia-focus-mode'); } catch { /* */ }
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <ClientBootstrap />

      <header className="lia-header">
        <div className="flex items-center gap-2 min-w-0">
          <div className="lia-header-logo" aria-hidden>
            <span>Л</span>
          </div>
          <div className="min-w-0 flex flex-col justify-center leading-none gap-0.5">
            <span className="text-[0.9375rem] font-display font-semibold tracking-tight text-foreground">
              Лия
            </span>
            <span className="text-[0.625rem] text-text-dim font-display tracking-wide hidden sm:block">
              рядом
            </span>
          </div>
        </div>

        <div className="flex-1" />

        <HeaderStatus
          episodesCollapsed={episodesCollapsed}
          onToggleEpisodes={toggleEpisodes}
          avatarMode={avatarMode}
          onCycleAvatar={cycleAvatarMode}
          kbOpen={kbOpen}
          onToggleKb={toggleKb}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
        <SettingsLink />
      </header>

      <OllamaBanner />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {!episodesCollapsed && (
          <EpisodesSidebar />
        )}

        <main className="lia-chat-main flex-1 flex flex-col min-w-0">
          <PanelErrorBoundary fallbackTitle="Чат временно недоступен">
            <ChatPanel
              companionBeside={avatarMode === 'portrait'}
              onCycleAvatar={cycleAvatarMode}
            />
          </PanelErrorBoundary>
        </main>

        {avatarMode === 'full' && (
          <PanelErrorBoundary fallbackTitle="Образ временно недоступен">
            <AvatarColumn onCycleMode={cycleAvatarMode} />
          </PanelErrorBoundary>
        )}
      </div>

      <KbSidebar open={kbOpen} onOpenChange={setKbOpen} />

      <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
