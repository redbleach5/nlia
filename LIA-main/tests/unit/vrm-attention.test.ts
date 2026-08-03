import { describe, expect, it } from 'vitest';
import {
  createAttentionState,
  setAttentionLook,
  triggerAttentionGesture,
  tickAttention,
  LOOK_ANCHORS,
} from '@/components/lia/vrm/attention';

describe('avatar attention', () => {
  it('looks toward composer anchor', () => {
    const s = createAttentionState();
    setAttentionLook(s, 'composer', 2);
    expect(s.targetLookX).toBeCloseTo(LOOK_ANCHORS.composer.x);
    expect(s.lookHoldSec).toBe(2);
  });

  it('nod gesture peaks then clears', () => {
    const s = createAttentionState();
    triggerAttentionGesture(s, 'nod');
    const mid = tickAttention(s, 0.3, { enableIdleGlance: false });
    expect(mid.headPitch).toBeGreaterThan(0.05);
    tickAttention(s, 0.5, { enableIdleGlance: false });
    expect(s.gesture).toBeNull();
  });

  it('idle glance only when not holding look', () => {
    const s = createAttentionState();
    setAttentionLook(s, 'chat', 5);
    s.glanceTimer = 0;
    tickAttention(s, 0.05, { enableIdleGlance: true });
    expect(s.targetGlanceX).toBe(0);
  });
});
