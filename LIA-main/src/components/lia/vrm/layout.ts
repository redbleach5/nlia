// ============================================================================
// VRM layout — нормализация по голове + земля под CAMERA_PRESETS.
// ============================================================================
//
// Масштаб по полному bbox ломается на высоких волосах / крыльях / T-pose:
// модель сжимается, лицо уезжает из портретного кадра.
// Надёжнее: привести head bone к REFERENCE_HEAD_Y, затем поставить ноги на Y=0.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/** Целевая высота кости head (м) — под портретные CAMERA_PRESETS / sidebar. */
export const REFERENCE_HEAD_Y = 1.45;

/** Полная высота «эталонного» VRoid (для логов / fullbody). */
export const REFERENCE_MODEL_HEIGHT = 1.666;

const MIN_SCALE = 0.55;
const MAX_SCALE = 1.75;

export type VrmLayoutMetrics = {
  rawHeadY: number;
  rawHeight: number;
  normalizeScale: number;
  headY: number;
  hipsY: number;
};

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _head = new THREE.Vector3();
const _hips = new THREE.Vector3();

function readHeadHips(vrm: VRM): { headY: number; hipsY: number } {
  const humanoid = vrm.humanoid;
  let headY = 0;
  let hipsY = 0;
  if (humanoid) {
    const head = humanoid.getNormalizedBoneNode('head' as never)
      ?? humanoid.getRawBoneNode('head' as never);
    const hips = humanoid.getNormalizedBoneNode('hips' as never)
      ?? humanoid.getRawBoneNode('hips' as never);
    if (head) {
      head.getWorldPosition(_head);
      headY = _head.y;
    }
    if (hips) {
      hips.getWorldPosition(_hips);
      hipsY = _hips.y;
    }
  }
  return { headY, hipsY };
}

/** Shift model so bbox min Y = 0 (+ optional offset). Does not change scale. */
export function groundVrm(vrm: VRM, yOffset = 0): void {
  vrm.scene.updateMatrixWorld(true);
  _box.setFromObject(vrm.scene);
  const dy = -_box.min.y + (Number.isFinite(yOffset) ? yOffset : 0);
  vrm.scene.position.y += dy;
  vrm.scene.updateMatrixWorld(true);
}

/**
 * Scale by head bone → REFERENCE_HEAD_Y, then ground feet.
 * Call AFTER rotateVRM0 + humanoid.update(); re-ground after arm pose if needed.
 */
export function applyVrmLayout(
  vrm: VRM,
  opts: { userScale: number; yOffset: number },
): VrmLayoutMetrics {
  vrm.scene.scale.setScalar(1);
  vrm.scene.position.set(0, 0, 0);
  try {
    vrm.humanoid?.update();
  } catch { /* ignore */ }
  vrm.scene.updateMatrixWorld(true);

  _box.setFromObject(vrm.scene);
  const footY = _box.min.y;
  const rawHeight = Math.max(0.05, _box.max.y - footY);
  const { headY: rawHeadY, hipsY: rawHipsY } = readHeadHips(vrm);

  // Scale so (head − feet) → REFERENCE_HEAD_Y; after grounding head sits at 1.45.
  let normalizeScale = 1;
  const headAboveFeet = rawHeadY - footY;
  if (headAboveFeet > 0.15) {
    normalizeScale = REFERENCE_HEAD_Y / headAboveFeet;
  } else {
    normalizeScale = REFERENCE_MODEL_HEIGHT / rawHeight;
  }
  normalizeScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, normalizeScale));

  const userScale = Number.isFinite(opts.userScale) ? opts.userScale : 1;
  vrm.scene.scale.setScalar(normalizeScale * userScale);
  vrm.scene.updateMatrixWorld(true);

  groundVrm(vrm, opts.yOffset);

  const { headY, hipsY } = readHeadHips(vrm);
  _box.setFromObject(vrm.scene);
  _box.getSize(_size);

  return {
    rawHeadY: rawHeadY || rawHipsY,
    rawHeight,
    normalizeScale,
    headY,
    hipsY,
  };
}
