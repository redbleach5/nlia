import { describe, expect, it } from 'vitest';
import { ExpressionBinder } from '@/components/lia/vrm/expressions';
import { REFERENCE_HEAD_Y, REFERENCE_MODEL_HEIGHT } from '@/components/lia/vrm/layout';
import { emotionToBlendshapes } from '@/components/lia/vrm/blendshapes';

describe('vrm/layout', () => {
  it('exposes camera-tuned reference head height', () => {
    expect(REFERENCE_HEAD_Y).toBeCloseTo(1.45, 3);
    expect(REFERENCE_MODEL_HEIGHT).toBeCloseTo(1.666, 3);
  });
});

describe('vrm/blendshapes emotionToBlendshapes', () => {
  it('maps joy above threshold to happy', () => {
    const out = emotionToBlendshapes({
      joy: 0.9, curiosity: 0.5, calm: 0.5, irritation: 0.2, sadness: 0.1,
    });
    expect(out.happy).toBeGreaterThan(0.4);
    expect(out.angry).toBe(0);
  });
});

describe('ExpressionBinder', () => {
  function mockVrm(names: string[]) {
    const map = new Map(names.map((n) => [n, { name: n }]));
    return {
      expressionManager: {
        getExpression: (name: string) => map.get(name) ?? null,
        setValue: viFn(),
      },
    };
  }

  function viFn() {
    const calls: Array<[string, number]> = [];
    const fn = (name: string, value: number) => { calls.push([name, value]); };
    fn.calls = calls;
    return fn;
  }

  it('uses blink when present', () => {
    const vrm = mockVrm(['blink', 'happy', 'aa']) as never;
    const binder = new ExpressionBinder(vrm);
    binder.set('blink', 0.8);
    const setValue = (vrm as { expressionManager: { setValue: { calls: Array<[string, number]> } } })
      .expressionManager.setValue;
    expect(setValue.calls).toEqual([['blink', 0.8]]);
  });

  it('falls back to blinkLeft/Right pair', () => {
    const vrm = mockVrm(['blinkLeft', 'blinkRight', 'happy']) as never;
    const binder = new ExpressionBinder(vrm);
    expect(binder.supported()).toContain('blink');
    binder.set('blink', 1);
    const setValue = (vrm as { expressionManager: { setValue: { calls: Array<[string, number]> } } })
      .expressionManager.setValue;
    expect(setValue.calls).toEqual([
      ['blinkLeft', 1],
      ['blinkRight', 1],
    ]);
  });

  it('no-ops missing expressions', () => {
    const vrm = mockVrm(['aa']) as never;
    const binder = new ExpressionBinder(vrm);
    binder.set('happy', 1);
    const setValue = (vrm as { expressionManager: { setValue: { calls: Array<[string, number]> } } })
      .expressionManager.setValue;
    expect(setValue.calls).toEqual([]);
  });
});

describe('ensureVerticalLookAtRange', () => {
  it('boosts only bone lookAt appliers', async () => {
    const { ensureVerticalLookAtRange } = await import('@/components/lia/vrm/gaze');

    class BoneApplier {
      static readonly type = 'bone';
      rangeMapVerticalUp = { outputScale: 8 };
      rangeMapVerticalDown = { outputScale: 8 };
    }
    class ExpressionApplier {
      static readonly type = 'expression';
      rangeMapVerticalUp = { outputScale: 1 };
      rangeMapVerticalDown = { outputScale: 1 };
    }

    const bone = new BoneApplier();
    ensureVerticalLookAtRange({ lookAt: { applier: bone } } as never);
    expect(bone.rangeMapVerticalUp.outputScale).toBe(22);

    const expr = new ExpressionApplier();
    ensureVerticalLookAtRange({ lookAt: { applier: expr } } as never);
    expect(expr.rangeMapVerticalUp.outputScale).toBe(1);
  });
});

describe('applyArmPose', () => {
  it('prefers flipped Z for VRM 1.0 meta', async () => {
    const { applyArmPose } = await import('@/components/lia/vrm/arm-pose');
    const rotations: Record<string, [number, number, number]> = {};
    const nodes: Record<string, { rotation: { set: (x: number, y: number, z: number) => void }; getWorldPosition: (v: { set: (x: number, y: number, z: number) => void }) => void }> = {};

    for (const name of [
      'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
      'leftHand', 'rightHand', 'leftShoulder',
    ]) {
      nodes[name] = {
        rotation: {
          set: (x, y, z) => { rotations[name] = [x, y, z]; },
        },
        getWorldPosition: (v) => {
          // After VRM1 flip, hands below shoulders → no second flip.
          if (name === 'leftShoulder' || name === 'leftUpperArm') v.set(0, 1.4, 0);
          else v.set(0, 0.9, 0);
        },
      };
    }

    const vrm = {
      meta: { metaVersion: '1' },
      scene: { updateMatrixWorld: () => {} },
      humanoid: {
        autoUpdateHumanBones: false,
        getNormalizedBoneNode: (name: string) => nodes[name] ?? null,
        update: () => {},
      },
    };

    const result = applyArmPose(vrm as never, 'natural');
    expect(result.flippedZ).toBe(true);
    // VRM0 natural leftUpperArm.z = +1.35 → flipped −1.35
    expect(rotations.leftUpperArm?.[2]).toBeCloseTo(-1.35);
    expect(rotations.rightUpperArm?.[2]).toBeCloseTo(1.35);
  });
});
