// ============================================================================
// Avatar cues — window events for look / gesture (UI → VRM).
// ============================================================================

import type { AvatarGestureKind, AvatarLookAnchor } from '@/components/lia/vrm/attention';

export const LIA_AVATAR_LOOK = 'lia-avatar-look';
export const LIA_AVATAR_GESTURE = 'lia-avatar-gesture';

export type AvatarLookDetail = AvatarLookAnchor | { x: number; y: number; holdSec?: number };

export function cueAvatarLook(target: AvatarLookDetail, holdSec?: number): void {
  if (typeof window === 'undefined') return;
  const detail = typeof target === 'string'
    ? { anchor: target, holdSec }
    : { x: target.x, y: target.y, holdSec: holdSec ?? target.holdSec };
  window.dispatchEvent(new CustomEvent(LIA_AVATAR_LOOK, { detail }));
}

export function cueAvatarGesture(kind: AvatarGestureKind): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LIA_AVATAR_GESTURE, { detail: { kind } }));
}
