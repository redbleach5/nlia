'use client';

// Circular companion face — beside Lia's latest message, or centered when empty.

import { useChatStore } from '@/stores/chat-store';
import dynamic from 'next/dynamic';
import { type ReactNode, Component } from 'react';
import { BackgroundLayer } from './vrm/background';
import { cn } from '@/lib/utils';
import { usePresenceAvatar } from '@/hooks/use-presence-avatar';
import { isAgentBusyStatus } from '@/lib/agent/task-status-ui';

const VrmAvatar = dynamic(() => import('./vrm-avatar').then(m => m.VrmAvatar), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-text-dim text-[10px]">
      …
    </div>
  ),
});

type CompanionPortraitProps = {
  onCycleMode: () => void;
  /** md — next to a message; lg — empty chat hero */
  size?: 'md' | 'lg';
  className?: string;
};

const SIZE_CLASS = {
  // md was 3.25rem (~52px) — too small for a readable VRM face
  md: 'w-[5.5rem] h-[5.5rem] rounded-full',
  lg: 'w-[10rem] h-[10rem] rounded-full',
} as const;

const STATUS_DOT_CLASS = {
  md: 'w-3 h-3',
  lg: 'w-3.5 h-3.5',
} as const;

export function CompanionPortrait({
  onCycleMode,
  size = 'md',
  className,
}: CompanionPortraitProps) {
  const emotion = useChatStore(s => s.emotion);
  const isStreaming = useChatStore(s => s.isStreaming);
  const activeTaskStatus = useChatStore(s => s.activeTaskStatus);
  const agentActive = isAgentBusyStatus(activeTaskStatus);

  const {
    settingsReady,
    vrmSrc,
    avatarConfig,
    vrmFailed,
    handleVrmError,
  } = usePresenceAvatar();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onCycleMode}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCycleMode();
        }
      }}
      className={cn(
        'relative shrink-0 outline-none overflow-hidden cursor-pointer',
        'border border-border bg-surface shadow-sm',
        'transition-[box-shadow,transform] duration-150',
        'hover:shadow-md hover:-translate-y-px',
        'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        size === 'lg' ? SIZE_CLASS.lg : SIZE_CLASS.md,
        className,
      )}
      title="Клик — сменить режим аватара"
      aria-label="Сменить режим аватара"
    >
      <div className="absolute inset-0 overflow-hidden rounded-full lia-presence-stage pointer-events-none">
        {settingsReady && (
          <BackgroundLayer background={avatarConfig.background} edgeToEdge />
        )}
        <div className="absolute inset-0">
          {!settingsReady ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : !vrmSrc || vrmFailed ? (
            <div className="absolute inset-0 flex items-center justify-center text-[9px] text-text-dim font-display">
              Л
            </div>
          ) : (
            <VrmErrorBoundary key={vrmSrc} onError={handleVrmError}>
              <VrmAvatar
                fill
                compact
                emotion={emotion}
                speaking={isStreaming}
                src={vrmSrc}
                config={avatarConfig}
                onLoadError={handleVrmError}
              />
            </VrmErrorBoundary>
          )}
        </div>
      </div>

      {(isStreaming || agentActive) && (
        <span
          className={cn(
            'absolute bottom-0.5 right-0.5 z-20 rounded-full border-2 border-background',
            size === 'lg' ? STATUS_DOT_CLASS.lg : STATUS_DOT_CLASS.md,
            agentActive ? 'bg-accent-2 animate-pulse' : 'bg-accent animate-pulse',
          )}
          aria-hidden
        />
      )}
    </div>
  );
}

class VrmErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; onError: () => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[CompanionPortrait]', error);
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center rounded-full bg-accent/10">
          <span className="text-sm font-display font-semibold text-accent" aria-hidden>Л</span>
        </div>
      );
    }
    return this.props.children;
  }
}
