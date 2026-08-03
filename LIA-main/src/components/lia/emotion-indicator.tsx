'use client';

import { dominantEmotion } from '@/lib/emotion';
import type { EmotionVector, EmotionAxis } from '@/lib/personality';
import { EMOTION_AXES, EMOTION_LABELS_RU } from '@/lib/personality';
import { EMOTION_COLORS } from './vrm/constants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Heart, Cloud, Frown, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const EMOTION_ICONS: Record<Exclude<EmotionAxis, 'curiosity'>, LucideIcon> = {
  joy: Heart,
  calm: Cloud,
  irritation: Zap,
  sadness: Frown,
};

const EMOTION_DOT: Record<EmotionAxis, string> = {
  joy: 'bg-amber-400',
  curiosity: 'bg-accent-2',
  calm: 'bg-sky-400',
  irritation: 'bg-orange-500',
  sadness: 'bg-slate-400',
};

function AnimatedSparkles({ color, className }: { color: string; className?: string }) {
  return (
    <span className={cn('lia-mood-sparkles shrink-0', className)} style={{ color }} aria-hidden>
      <span className="lia-mood-sparkle lia-mood-sparkle-1" />
      <span className="lia-mood-sparkle lia-mood-sparkle-2" />
      <span className="lia-mood-sparkle lia-mood-sparkle-3" />
    </span>
  );
}

function EmotionMoodIcon({ axis, color }: { axis: EmotionAxis; color: string }) {
  if (axis === 'curiosity') {
    return <AnimatedSparkles color={color} />;
  }
  const Icon = EMOTION_ICONS[axis];
  return (
    <Icon
      className="w-3.5 h-3.5 shrink-0 transition-colors duration-500"
      style={{ color }}
      aria-hidden
    />
  );
}

function EmotionBars({ emotion }: { emotion: EmotionVector }) {
  return (
    <div className="space-y-2">
      {EMOTION_AXES.map(axis => {
        const value = emotion[axis];
        const pct = Math.round(value * 100);
        return (
          <div key={axis} className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground capitalize">
                {EMOTION_LABELS_RU[axis]}
              </span>
              <span className="font-mono text-text-dim">
                {pct.toString().padStart(2, '0')}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent/70 transition-all duration-700"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Настроение Лии — правый верхний угол сцены. */
export function EmotionIndicator({ emotion }: { emotion: EmotionVector }) {
  const dom = dominantEmotion(emotion);
  const domLabel = EMOTION_LABELS_RU[dom];
  const domValue = Math.round(emotion[dom] * 100);
  const glow = EMOTION_COLORS[dom].glow;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Настроение: ${domLabel} ${domValue}%`}
          aria-label={`Настроение Лии: ${domLabel}. Нажми для подробностей`}
          className="pointer-events-auto lia-status-chip lia-status-chip-icon-only"
        >
          <EmotionMoodIcon axis={dom} color={glow} />
          <span className={cn('lia-status-chip-dot', EMOTION_DOT[dom])} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="lia-stage-popover w-64 p-3 rounded-xl border-border/60 shadow-xl"
      >
        <div className="mb-2">
          <p className="text-sm font-medium text-foreground">Настроение</p>
          <p className="text-[11px] text-text-dim mt-0.5">
            Сейчас: <span style={{ color: EMOTION_COLORS[dom].glow }}>{domLabel}</span>
            {' · '}
            <span className="font-mono tabular-nums">{domValue}%</span>
          </p>
        </div>
        <EmotionBars emotion={emotion} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
