'use client';

import type { EmotionVector } from '@/lib/personality';
import { dominantEmotion } from '@/lib/emotion';
import { EMOTION_COLORS } from './vrm/constants';
import { type AvatarConfig, type CameraPreset } from '@/lib/avatar-config';
import { BackgroundLayer } from './vrm/background';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type PresenceStageProps = {
  emotion: EmotionVector;
  cameraPreset: CameraPreset;
  /** Фон из AvatarConfig — иначе дефолтный тёплый градиент. */
  background?: AvatarConfig['background'];
  children: ReactNode;
};

/**
 * Полноэкранная (в пределах колонки) сцена без «коробки».
 * Portrait/closeup — мягкий crop снизу через градиент-маску.
 * Fullbody — вся высота колонки, без искусственного aspect-ratio.
 */
export function PresenceStage({
  emotion,
  cameraPreset,
  background,
  children,
}: PresenceStageProps) {
  const dom = dominantEmotion(emotion);
  const colors = EMOTION_COLORS[dom];
  const intensity = Math.max(0.25, emotion[dom] * 0.65);
  const isPortrait = cameraPreset === 'portrait' || cameraPreset === 'closeup';
  const cropFade = background?.edgeColor
    ?? background?.color
    ?? 'var(--surface-3)';

  return (
    <div className="relative w-full h-full min-h-0 overflow-hidden lia-presence-stage">
      {background ? (
        <BackgroundLayer background={background} edgeToEdge />
      ) : (
        <div className="absolute inset-0 lia-presence-stage-fallback" />
      )}

      <div
        className="pointer-events-none absolute inset-0 lia-emotion-aura"
        style={{
          ['--lia-aura-color' as string]: colors.glow,
          ['--lia-aura-strength' as string]: String(intensity),
        }}
      />

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_42%,transparent_0%,rgba(26,26,26,0.06)_100%)]" />

      <div
        className={cn(
          'absolute inset-0',
          isPortrait && 'lia-presence-portrait-crop',
        )}
      >
        {children}
      </div>

      {isPortrait && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[16%] z-[1]"
          style={{
            background: `linear-gradient(to top, ${cropFade} 0%, transparent 100%)`,
          }}
        />
      )}
    </div>
  );
}
