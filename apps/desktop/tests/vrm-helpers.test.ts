/**
 * Pure VRM helpers (no WebGL).
 */

import { describe, it, expect } from "vitest";
import { ExpressionBinder } from "../src/components/vrm/expressions.js";
import { createEmptyBases } from "../src/components/vrm/bones.js";
import { ARM_POSE_EULERS } from "../src/components/vrm/arm-pose.js";
import type { VRM } from "@pixiv/three-vrm";

describe("vrm bone bases", () => {
  it("creates empty bases with zero rotations", () => {
    const b = createEmptyBases();
    expect(b.head.rotX).toBe(0);
    expect(b.hips.posY).toBe(0);
    expect(b.leftUpperArm.rotZ).toBe(0);
  });
});

describe("arm pose presets", () => {
  it("has natural pose with opposite Z on upper arms", () => {
    expect(ARM_POSE_EULERS.natural.leftUpperArm[2]).toBeGreaterThan(0);
    expect(ARM_POSE_EULERS.natural.rightUpperArm[2]).toBeLessThan(0);
  });
});

describe("ExpressionBinder", () => {
  function fakeVrm(names: string[]): VRM {
    const exprs = new Map(names.map((n) => [n, {}]));
    return {
      expressionManager: {
        getExpression: (name: string) => exprs.get(name),
        setValue: (_name: string, _v: number) => {},
      },
    } as unknown as VRM;
  }

  it("uses blinkLeft/Right when blink preset missing", () => {
    const binder = new ExpressionBinder(fakeVrm(["blinkLeft", "blinkRight", "happy"]));
    expect(binder.supported()).toContain("blink");
    expect(binder.supported()).toContain("happy");
  });

  it("marks blink missing when no eye presets", () => {
    const binder = new ExpressionBinder(fakeVrm(["happy"]));
    expect(binder.supported()).not.toContain("blink");
  });
});
