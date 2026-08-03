import 'server-only';

// ============================================================================
// Project design bootstrap — infer + persist lia.project.json before scaffold.
// ============================================================================
// Not a user-facing accept/reject gate: v1 always writes the inferred design.
// SSE still emits design_proposed for the workbench; agent may refine via
// propose_design. Writes go only through safeWriteFile (no absolute fallback).

import { emitAgentEvent } from '../events';
import { safeWriteFile } from '../fs-scope';
import type { AgentTask } from '../task';
import { inferProjectDesign } from './infer-design';
import {
  PROJECT_MANIFEST_FILENAME,
  parseProjectDesign,
  serializeProjectDesign,
  type ProjectDesignInput,
} from './project-manifest';
import type { ProjectDesign } from './types';
import { logger } from '@/lib/logger';

export type DesignGateResult = {
  design: ProjectDesign;
  /** Always true in v1 — kept for SSE/UI compatibility. */
  autoAccepted: boolean;
  written: boolean;
};

/**
 * Infer design, emit SSE, write manifest via scoped FS only.
 */
export async function runDesignGate(task: AgentTask): Promise<DesignGateResult | null> {
  if (!task.fsScope) return null;

  const design = inferProjectDesign(task.goal);
  emitAgentEvent({
    type: 'design_proposed',
    taskId: task.id,
    design,
    autoAccepted: true,
    ts: Date.now(),
  });

  let written = false;
  try {
    await safeWriteFile(
      PROJECT_MANIFEST_FILENAME,
      task.fsScope,
      serializeProjectDesign(design),
    );
    written = true;
  } catch (e) {
    logger.warn('agent', 'design bootstrap: failed to write lia.project.json', {
      taskId: task.id.slice(0, 8),
    }, e instanceof Error ? e : undefined);
  }

  logger.info('agent', 'design bootstrap proposed', {
    taskId: task.id.slice(0, 8),
    kind: design.kind,
    preset: design.preset,
    stack: design.stack,
    written,
  });

  return { design, autoAccepted: true, written };
}

export async function persistProjectDesign(
  task: AgentTask,
  raw: ProjectDesignInput,
): Promise<{ ok: true; design: ProjectDesign } | { ok: false; error: string }> {
  if (!task.fsScope) {
    return { ok: false, error: 'Нет рабочей директории (fsScope) для манифеста' };
  }

  // Locked presets (static-game / static-web): ignore model stack/tree/scripts.
  const { resolveCreatePresetId, isLockedPreset, lockDesignToPreset } = await import('./presets');
  const presetId = resolveCreatePresetId(task.goal);
  const toParse: unknown = isLockedPreset(presetId)
    ? lockDesignToPreset(task.goal, {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      acceptance: typeof raw.acceptance === 'string' ? raw.acceptance : undefined,
    })
    : { ...raw, createdBy: 'lia' };

  const parsed = parseProjectDesign(toParse);
  if (!parsed.ok) return parsed;

  try {
    await safeWriteFile(
      PROJECT_MANIFEST_FILENAME,
      task.fsScope,
      serializeProjectDesign(parsed.design),
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  emitAgentEvent({
    type: 'design_proposed',
    taskId: task.id,
    design: parsed.design,
    autoAccepted: true,
    ts: Date.now(),
  });

  logger.info('agent', 'design persisted', {
    taskId: task.id.slice(0, 8),
    preset: parsed.design.preset,
    kind: parsed.design.kind,
    locked: isLockedPreset(presetId),
  });

  return { ok: true, design: parsed.design };
}

export { inferProjectDesign };
