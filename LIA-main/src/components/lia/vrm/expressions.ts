// ============================================================================
// Expression binder — устойчивые эмоции/моргание/рот across VRM0/1 exports.
// ============================================================================
//
// three-vrm обычно нормализует пресеты к happy/blink/aa, но у части моделей:
//   - нет `blink`, есть только blinkLeft/blinkRight
//   - нет части emotion presets → setValue молча no-op или кидает
// Binder резолвит logical name → реальные ключи один раз при load.

import type { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';

export type LogicalExpression =
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised'
  | 'aa'
  | 'blink'
  | 'lookLeft'
  | 'lookRight'
  | 'lookUp'
  | 'lookDown';

type ResolvedTarget =
  | { kind: 'single'; name: string }
  | { kind: 'pair'; left: string; right: string }
  | { kind: 'missing' };

const CANDIDATES: Record<LogicalExpression, string[]> = {
  happy: ['happy'],
  angry: ['angry'],
  sad: ['sad'],
  relaxed: ['relaxed'],
  surprised: ['surprised'],
  aa: ['aa'],
  blink: ['blink'],
  lookLeft: ['lookLeft'],
  lookRight: ['lookRight'],
  lookUp: ['lookUp'],
  lookDown: ['lookDown'],
};

function hasExpr(vrm: VRM, name: string): boolean {
  return Boolean(vrm.expressionManager?.getExpression(name));
}

export class ExpressionBinder {
  private readonly vrm: VRM;
  private readonly map = new Map<LogicalExpression, ResolvedTarget>();

  constructor(vrm: VRM) {
    this.vrm = vrm;
    for (const logical of Object.keys(CANDIDATES) as LogicalExpression[]) {
      this.map.set(logical, this.resolve(logical));
    }
  }

  private resolve(logical: LogicalExpression): ResolvedTarget {
    if (!this.vrm.expressionManager) return { kind: 'missing' };

    if (logical === 'blink') {
      if (hasExpr(this.vrm, 'blink')) return { kind: 'single', name: 'blink' };
      if (hasExpr(this.vrm, 'blinkLeft') && hasExpr(this.vrm, 'blinkRight')) {
        return { kind: 'pair', left: 'blinkLeft', right: 'blinkRight' };
      }
      return { kind: 'missing' };
    }

    for (const name of CANDIDATES[logical]) {
      if (hasExpr(this.vrm, name)) return { kind: 'single', name };
    }
    return { kind: 'missing' };
  }

  /** Which logical expressions this model actually supports. */
  supported(): LogicalExpression[] {
    return [...this.map.entries()]
      .filter(([, t]) => t.kind !== 'missing')
      .map(([k]) => k);
  }

  set(logical: LogicalExpression | string, value: number): void {
    const em = this.vrm.expressionManager;
    if (!em) return;
    const key = logical as LogicalExpression;
    const target = this.map.get(key);
    if (!target || target.kind === 'missing') return;

    const clamped = Math.max(0, Math.min(1, value));
    try {
      if (target.kind === 'pair') {
        em.setValue(target.left as VRMExpressionPresetName, clamped);
        em.setValue(target.right as VRMExpressionPresetName, clamped);
      } else {
        em.setValue(target.name as VRMExpressionPresetName, clamped);
      }
    } catch {
      // Ignore broken binds on exotic exports.
    }
  }
}
