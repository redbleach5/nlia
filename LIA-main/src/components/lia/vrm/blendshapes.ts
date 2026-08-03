// ============================================================================
// VRM blendshape helpers — emotion→blendshapes mapping + safe setExpr.
// ============================================================================

import type { VRM } from '@pixiv/three-vrm';
import type { EmotionVector } from '@/lib/personality';
import type { ExpressionBinder, LogicalExpression } from './expressions';

/**
 * Безопасно установить значение blendshape.
 * Prefer ExpressionBinder (resolves blink L/R, missing presets).
 */
export function setExpr(
  vrm: VRM,
  name: LogicalExpression | string,
  value: number,
  binder?: ExpressionBinder | null,
): void {
  if (binder) {
    binder.set(name, value);
    return;
  }
  if (!vrm.expressionManager) return;
  try {
    const clamped = Math.max(0, Math.min(1, value));
    vrm.expressionManager.setValue(name as never, clamped);
  } catch {
    /* ignore missing / broken binds */
  }
}

/**
 * Маппинг 5-axis emotion → VRM blendshape preset names.
 * Лёгкая фоновая улыбка/relaxed — лицо не «манекен», пока нет сильной грусти/злости.
 */
export function emotionToBlendshapes(e: EmotionVector): Record<string, number> {
  const gloom = Math.max(e.sadness, e.irritation);
  const restSmile = Math.max(0, 0.12 - gloom * 0.3);
  const restSoft = Math.max(0, 0.08 - gloom * 0.2);
  return {
    happy: restSmile + Math.max(0, e.joy - 0.35) * 1.05,
    angry: Math.max(0, e.irritation - 0.35) * 1.2,
    sad: Math.max(0, e.sadness - 0.3) * 1.1,
    relaxed: restSoft + Math.max(0, e.calm - 0.45) * 0.75,
    surprised: Math.max(0, e.curiosity - 0.75) * 0.25,
    aa: 0,
  };
}
