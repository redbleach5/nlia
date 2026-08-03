'use client';

import { useChatStore } from '@/stores/chat-store';
import dynamic from 'next/dynamic';
import { AgentStatusRing } from './agent-status-ring';
import { EmotionIndicator } from './emotion-indicator';
import { PresenceStage } from './presence-stage';
import { type ReactNode, Component } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePresenceAvatar } from '@/hooks/use-presence-avatar';
import { isAgentBusyStatus } from '@/lib/agent/task-status-ui';

const VrmAvatar = dynamic(() => import('./vrm-avatar').then(m => m.VrmAvatar), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-text-dim text-xs">
      Лия появляется…
    </div>
  ),
});

// ============================================================================
// AvatarColumn — full PresenceStage (320px справа).
// Portrait mode живёт в ChatPanel как CompanionPortrait (кружок у сообщений),
// не как отдельная колонка — этот компонент монтируется только при avatarMode=full.
// ============================================================================

type AvatarColumnProps = {
  onCycleMode: () => void;
};

function SpeakingBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full lia-glass-strong border border-accent/25 shadow-sm text-[10px] text-accent font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
      отвечает
    </span>
  );
}

type VrmMissingHintProps = {
  onShowPresence: () => void;
  busy: boolean;
};

function VrmMissingHint({ onShowPresence, busy }: VrmMissingHintProps) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <div
        className="w-16 h-16 rounded-full bg-accent/15 border border-accent/25 flex items-center justify-center"
        aria-hidden
      >
        <span className="text-2xl font-display font-semibold text-accent">Л</span>
      </div>
      <p className="text-sm font-display font-medium text-foreground">
        Образ Лии ещё не загружен
      </p>
      <p className="text-xs text-muted-foreground leading-relaxed max-w-[14rem]">
        Можно сразу показать готовый образ — или добавить свой в настройках → «Вид».
      </p>
      <button
        type="button"
        onClick={onShowPresence}
        disabled={busy}
        className="mt-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md
          bg-accent/20 hover:bg-accent/30 text-accent text-xs font-medium
          transition-colors disabled:opacity-60 disabled:pointer-events-none"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : null}
        Показать образ Лии
      </button>
    </div>
  );
}

export function AvatarColumn({ onCycleMode }: AvatarColumnProps) {
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
    downloadSample,
    downloading,
  } = usePresenceAvatar();

  const handleShowPresence = async () => {
    const result = await downloadSample();
    if (result.ok) {
      toast.success('Образ Лии готов');
    } else {
      toast.error(result.error ?? 'Не удалось загрузить образ');
    }
  };

  if (!settingsReady) {
    return (
      <aside className="lia-avatar-col-full relative lia-sidebar-panel shrink-0">
        <div className="absolute inset-0 flex items-center justify-center text-text-dim text-xs">
          <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" aria-label="Загрузка аватара" />
        </div>
      </aside>
    );
  }

  const vrmMissing = !vrmSrc || vrmFailed;

  const vrmNode = vrmMissing ? null : (
    <VrmErrorBoundary key={vrmSrc} onError={handleVrmError}>
      <VrmAvatar
        fill
        sidebar
        emotion={emotion}
        speaking={isStreaming}
        src={vrmSrc}
        config={avatarConfig}
        onLoadError={handleVrmError}
      />
    </VrmErrorBoundary>
  );

  return (
    <aside className="lia-avatar-col-full relative lia-sidebar-panel shrink-0">
      {/* Click cycle target — top-left corner so stage controls stay usable */}
      <button
        type="button"
        onClick={onCycleMode}
        className="absolute top-2 left-2 z-30 h-7 w-7 rounded-md text-text-dim/70 hover:text-foreground hover:bg-surface/80 transition-colors flex items-center justify-center opacity-60 hover:opacity-100"
        aria-label="Свернуть сцену аватара"
        title="Свернуть сцену"
      >
        <span className="text-sm leading-none" aria-hidden>×</span>
      </button>

      <div className="absolute inset-0 overflow-hidden">
        <PresenceStage
          emotion={emotion}
          cameraPreset={avatarConfig.camera.preset}
          background={avatarConfig.background}
        >
          <AgentStatusRing />
          {vrmMissing ? (
            <VrmMissingHint onShowPresence={handleShowPresence} busy={downloading} />
          ) : (
            vrmNode
          )}
        </PresenceStage>
      </div>

      <div className="absolute inset-0 z-20 pointer-events-none flex flex-col">
        <div className="p-3 flex items-start justify-between gap-2">
          <div className="flex flex-col items-start gap-1.5 min-w-0 pl-10">
            {isStreaming && !agentActive && <SpeakingBadge />}
          </div>
          <EmotionIndicator emotion={emotion} />
        </div>

        <div className="flex-1" />
      </div>
    </aside>
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
    console.error('[VrmErrorBoundary]', error);
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-xs text-muted-foreground">Образ не удалось показать</p>
          <p className="text-[11px] text-text-dim">Можно перезагрузить страницу или выбрать другой VRM в настройках.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
