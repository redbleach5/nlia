// ============================================================================
// Gaze — lookAt target + expression fallback (UI anchors / idle, not mouse).
// ============================================================================

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { setExpr } from './blendshapes';
import type { ExpressionBinder } from './expressions';

const _dir = new THREE.Vector3();
const _head = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();

/** Минимальный outputScale вертикальных range map (градусы кости). */
const MIN_VERTICAL_OUTPUT_SCALE = 22;

/**
 * Усилить вертикальный lookAt только для Bone applier.
 * На Expression lookAt outputScale≈1; поднятие до 22 ломает глаза.
 */
export function ensureVerticalLookAtRange(vrm: VRM): void {
  const applier = vrm.lookAt?.applier as {
    rangeMapVerticalUp?: { outputScale: number };
    rangeMapVerticalDown?: { outputScale: number };
    constructor?: { type?: string };
  } | undefined;
  if (!applier) return;

  const applierType = applier.constructor?.type;
  if (applierType !== 'bone') return;

  if (applier.rangeMapVerticalUp) {
    applier.rangeMapVerticalUp.outputScale = Math.max(
      applier.rangeMapVerticalUp.outputScale,
      MIN_VERTICAL_OUTPUT_SCALE,
    );
  }
  if (applier.rangeMapVerticalDown) {
    applier.rangeMapVerticalDown.outputScale = Math.max(
      applier.rangeMapVerticalDown.outputScale,
      MIN_VERTICAL_OUTPUT_SCALE,
    );
  }
}

/**
 * Цель взгляда: точка перед лицом + смещение в плоскости камеры (UI / idle).
 */
export function updateGazeTarget(
  gazeTarget: THREE.Object3D,
  headBone: THREE.Object3D,
  camera: THREE.Camera,
  offset: { x: number; y: number },
  distance = 1.6,
): void {
  headBone.getWorldPosition(_head);
  _dir.copy(camera.position).sub(_head).normalize();
  gazeTarget.position.copy(_head).addScaledVector(_dir, distance);

  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

  gazeTarget.position.addScaledVector(_camRight, offset.x * 0.75 * distance);
  gazeTarget.position.addScaledVector(_camUp, offset.y * 0.6 * distance);
}

/** Gaze via expression presets when vrm.lookAt is missing. */
export function applyExpressionGaze(
  vrm: VRM,
  offset: { x: number; y: number },
  binder?: ExpressionBinder | null,
): void {
  const ax = Math.abs(offset.x) < 0.02 ? 0 : offset.x;
  const ay = Math.abs(offset.y) < 0.02 ? 0 : offset.y;
  if (ax === 0 && ay === 0) {
    for (const n of ['lookLeft', 'lookRight', 'lookUp', 'lookDown'] as const) {
      setExpr(vrm, n, 0, binder);
    }
    return;
  }
  setExpr(vrm, 'lookLeft', Math.max(0, -ax * 0.9), binder);
  setExpr(vrm, 'lookRight', Math.max(0, ax * 0.9), binder);
  setExpr(vrm, 'lookUp', Math.max(0, ay * 0.75), binder);
  setExpr(vrm, 'lookDown', Math.max(0, -ay * 0.75), binder);
}
