// ============================================================================
// Heuristic Design Gate — delegates to canonical presets.
// ============================================================================

import type { ProjectDesign } from './types';
import { designFromPreset, resolveCreatePresetId } from './presets';

/**
 * Infer a sensible ProjectDesign from the user goal.
 * Simple games/sites always get locked static presets (index.html + serve).
 */
export function inferProjectDesign(goal: string): ProjectDesign {
  return designFromPreset(goal);
}

/** True when design expects a managed runtime verify before ГОТОВО. */
export function designNeedsRuntimeVerify(design: ProjectDesign): boolean {
  return design.preview.type === 'iframe' || design.preview.type === 'terminal';
}

export function createPresetIdForGoal(goal: string) {
  return resolveCreatePresetId(goal);
}
