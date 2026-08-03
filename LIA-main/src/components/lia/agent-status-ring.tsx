'use client';

// ============================================================================
// AgentStatusRing — кольцо прогресса вокруг сцены с аватаром.
// ============================================================================
//
// SVG кольцо поверх сцены (масштабируется с контейнером). Заполняется пропорционально
// currentStep/maxSteps. Цвет = текущая фаза агента.
//
// Когда агент не активен — кольцо скрыто.
// Когда planning (нет шагов) — кольцо "пульсирует" (indeterminate mode).
// Когда executing — кольцо заполняется по шагам.
// Когда done — кольцо полностью зелёное + лёгкий glow.
// Когда failed — красное кольцо.
//
// ВАЖНО: ring не должен мешать взаимодействию с аватаром (OrbitControls).
// pointer-events: none на SVG, интерактивность сохраняется.

import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';

// ============================================================================
// Цвета фаз агента (совпадают с status parts в bubble)
// ============================================================================
const PHASE_COLORS: Record<string, { stroke: string; glow: string }> = {
  planning:     { stroke: '#f59e0b', glow: 'rgba(245, 158, 11, 0.4)' },  // amber
  executing:    { stroke: '#8b6f47', glow: 'rgba(139, 111, 71, 0.4)' },  // accent (brown)
  waiting_input: { stroke: '#c9a886', glow: 'rgba(201, 168, 134, 0.4)' }, // warning
  synthesizing: { stroke: '#4a5870', glow: 'rgba(74, 88, 112, 0.4)' },  // accent-2
  done:         { stroke: '#6b8e5a', glow: 'rgba(107, 142, 90, 0.5)' },  // success
  failed:       { stroke: '#c2664a', glow: 'rgba(194, 102, 74, 0.4)' },  // destructive
  cancelled:    { stroke: '#a0a0a0', glow: 'rgba(160, 160, 160, 0.3)' }, // dim
};

export function AgentStatusRing() {
  const status = useChatStore(s => s.activeTaskStatus);
  const steps = useChatStore(s => s.activeTaskSteps);
  const agentTasks = useChatStore(s => s.agentTasks);
  const activeTaskId = useChatStore(s => s.activeTaskId);

  // Скрываем если задача не активна
  if (!status || status === 'pending' || status === 'cancelled') return null;

  const colors = PHASE_COLORS[status] ?? PHASE_COLORS.executing;

  // Находим активную задачу для maxSteps
  const activeTask = agentTasks.find(t => t.id === activeTaskId);
  const maxSteps = activeTask?.maxSteps ?? 0;
  const currentStep = steps.length;

  // Кольцо масштабируется вместе с родительской сценой (100% × 100%)
  const size = 100;
  const stroke = 2.5;
  const radius = (size - stroke) / 2 - 3;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Прогресс:
  // - planning/synthesizing (indeterminate) — 25% заполнения, пульсация
  // - executing — пропорционально currentStep/maxSteps
  // - done — 100%
  // - failed — 100% (но красный)
  let progress = 0;
  let indeterminate = false;

  if (status === 'done' || status === 'failed') {
    progress = 1;
  } else if (status === 'planning' || status === 'synthesizing' || status === 'waiting_input') {
    // Indeterminate — анимация через CSS, рисуем 30% дуги которая вращается
    progress = 0.3;
    indeterminate = true;
  } else if (status === 'executing' && maxSteps > 0) {
    // Пропорционально шагам, но минимум 5% чтобы было видно
    progress = Math.max(0.05, Math.min(1, currentStep / maxSteps));
  } else if (status === 'executing') {
    // executing без maxSteps — indeterminate
    progress = 0.3;
    indeterminate = true;
  }

  const dashOffset = circumference * (1 - progress);

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-10"
      viewBox={`0 0 ${size} ${size}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Фоновое кольцо (тонкое, полупрозрачное) — НЕ вращается. */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={colors.stroke}
        strokeOpacity="0.15"
        strokeWidth={stroke}
      />

      {/* Прогресс-кольцо — только ОНО вращается в indeterminate mode.
          UI-H16 fix: previously the entire SVG (background + progress) was
          spun via `animate-spin` on the parent, so both rings rotated
          together — looked like a single rotating circle rather than an
          indeterminate progress indicator. Now we wrap only the progress
          circle in a <g> with the spin animation. */}
      <g
        className={indeterminate ? 'animate-spin origin-center' : ''}
        style={indeterminate ? { animationDuration: '4s', transformOrigin: 'center' } : undefined}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          // Плавное заполнение
          style={{
            transition: 'stroke-dashoffset 0.6s ease-out, stroke 0.3s ease',
            // Glow effect для активного кольца
            filter: `drop-shadow(0 0 4px ${colors.glow})`,
          }}
          // Начинаем с верха (12 часов), не с 3 часов
          transform={`rotate(-90 ${center} ${center})`}
        />
      </g>

      {/* Для done — дополнительные искры/частицы (опционально, позже) */}
    </svg>
  );
}
