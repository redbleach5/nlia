// ============================================================================
// Avatar attention — look targets + short gestures (no mouse tracking).
// ============================================================================

export type AvatarLookAnchor = 'user' | 'chat' | 'composer' | 'settings';

export type AvatarGestureKind = 'nod' | 'acknowledge';

/** Screen-plane offsets from avatar’s view (avatar column on the right → chat is −X). */
export const LOOK_ANCHORS: Record<AvatarLookAnchor, { x: number; y: number }> = {
  user: { x: 0, y: 0.02 },
  chat: { x: -0.42, y: 0.05 },
  composer: { x: -0.38, y: -0.32 },
  settings: { x: -0.5, y: 0.42 },
};

export type AttentionState = {
  /** Current smoothed look offset */
  lookX: number;
  lookY: number;
  targetLookX: number;
  targetLookY: number;
  /** Hold intentional look before returning to idle glance */
  lookHoldSec: number;
  /** Soft idle wander when not holding a UI look */
  glanceTimer: number;
  glanceX: number;
  glanceY: number;
  targetGlanceX: number;
  targetGlanceY: number;
  gesture: null | { kind: AvatarGestureKind; t: number; duration: number };
};

export function createAttentionState(): AttentionState {
  return {
    lookX: 0,
    lookY: 0,
    targetLookX: 0,
    targetLookY: 0,
    lookHoldSec: 0,
    glanceTimer: 2 + Math.random() * 3,
    glanceX: 0,
    glanceY: 0,
    targetGlanceX: 0,
    targetGlanceY: 0,
    gesture: null,
  };
}

export function setAttentionLook(
  state: AttentionState,
  anchor: AvatarLookAnchor | { x: number; y: number },
  holdSec = 2.8,
): void {
  const target = typeof anchor === 'string' ? LOOK_ANCHORS[anchor] : anchor;
  state.targetLookX = target.x;
  state.targetLookY = target.y;
  state.lookHoldSec = holdSec;
  // Pause idle glance while focused
  state.targetGlanceX = 0;
  state.targetGlanceY = 0;
}

export function triggerAttentionGesture(state: AttentionState, kind: AvatarGestureKind): void {
  const duration = kind === 'nod' ? 0.65 : 0.9;
  state.gesture = { kind, t: 0, duration };
}

/**
 * Advance attention: look lerp, idle glance, gesture clock.
 * Returns offsets to apply this frame.
 */
export function tickAttention(
  state: AttentionState,
  delta: number,
  opts: { enableIdleGlance: boolean },
): {
  gazeX: number;
  gazeY: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
} {
  if (state.lookHoldSec > 0) {
    state.lookHoldSec = Math.max(0, state.lookHoldSec - delta);
    if (state.lookHoldSec <= 0) {
      state.targetLookX = 0;
      state.targetLookY = 0;
    }
  }

  const lookLerp = 1 - Math.pow(0.06, delta);
  state.lookX += (state.targetLookX - state.lookX) * lookLerp;
  state.lookY += (state.targetLookY - state.lookY) * lookLerp;

  const holdingLook = state.lookHoldSec > 0
    || Math.abs(state.targetLookX) > 0.02
    || Math.abs(state.targetLookY) > 0.02;

  if (opts.enableIdleGlance && !holdingLook) {
    state.glanceTimer -= delta;
    if (state.glanceTimer <= 0) {
      state.targetGlanceX = (Math.random() - 0.5) * 0.45;
      state.targetGlanceY = (Math.random() - 0.5) * 0.22;
      state.glanceTimer = 2.5 + Math.random() * 4.5;
    }
    const gLerp = 1 - Math.pow(0.04, delta);
    state.glanceX += (state.targetGlanceX - state.glanceX) * gLerp;
    state.glanceY += (state.targetGlanceY - state.glanceY) * gLerp;
  } else {
    const gLerp = 1 - Math.pow(0.08, delta);
    state.glanceX += (0 - state.glanceX) * gLerp;
    state.glanceY += (0 - state.glanceY) * gLerp;
    state.targetGlanceX = 0;
    state.targetGlanceY = 0;
  }

  let headYaw = 0;
  let headPitch = 0;
  let headRoll = 0;

  if (state.gesture) {
    state.gesture.t += delta;
    const u = Math.min(1, state.gesture.t / state.gesture.duration);
    const wave = Math.sin(u * Math.PI);
    if (state.gesture.kind === 'nod') {
      headPitch = wave * 0.18;
    } else {
      // acknowledge — soft nod + tilt
      headPitch = wave * 0.12;
      headRoll = wave * 0.08;
      headYaw = wave * 0.04;
    }
    if (u >= 1) state.gesture = null;
  }

  const gazeX = state.lookX + state.glanceX;
  const gazeY = state.lookY + state.glanceY;

  return {
    gazeX,
    gazeY,
    headYaw: headYaw + gazeX * 0.07,
    headPitch: headPitch + gazeY * 0.05,
    headRoll,
  };
}
