/**
 * Arm pose presets + VRM0/1 Z-axis auto-correct.
 * Ported from LIA-main vrm/arm-pose.ts + constants.ts.
 */

import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

export type ArmPose = "natural" | "relaxed" | "t-pose" | "crossed" | "hands-pockets";

type Euler3 = [number, number, number];

/** Euler XYZ for normalized bones. Name is historical (v2). */
export const ARM_POSE_EULERS: Record<
  ArmPose,
  {
    leftUpperArm: Euler3;
    rightUpperArm: Euler3;
    leftLowerArm: Euler3;
    rightLowerArm: Euler3;
    leftHand: Euler3;
    rightHand: Euler3;
  }
> = {
  natural: {
    leftUpperArm: [0.05, 0, 1.35],
    rightUpperArm: [0.05, 0, -1.35],
    leftLowerArm: [-0.25, 0, 0],
    rightLowerArm: [-0.25, 0, 0],
    leftHand: [0, 0, -0.15],
    rightHand: [0, 0, 0.15],
  },
  relaxed: {
    leftUpperArm: [0.1, 0, 1.15],
    rightUpperArm: [0.1, 0, -1.15],
    leftLowerArm: [-0.55, -0.05, 0],
    rightLowerArm: [-0.55, 0.05, 0],
    leftHand: [0, 0, -0.2],
    rightHand: [0, 0, 0.2],
  },
  "t-pose": {
    leftUpperArm: [0, 0, 0],
    rightUpperArm: [0, 0, 0],
    leftLowerArm: [0, 0, 0],
    rightLowerArm: [0, 0, 0],
    leftHand: [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  crossed: {
    leftUpperArm: [1.2, 0.8, 0.2],
    rightUpperArm: [1.2, -0.8, -0.2],
    leftLowerArm: [-1.6, 0, -0.6],
    rightLowerArm: [-1.6, 0, 0.6],
    leftHand: [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  "hands-pockets": {
    leftUpperArm: [0.2, 0, 0.95],
    rightUpperArm: [0.2, 0, -0.95],
    leftLowerArm: [-0.85, -0.15, 0],
    rightLowerArm: [-0.85, 0.15, 0],
    leftHand: [0, 0, -0.3],
    rightHand: [0, 0, 0.3],
  },
};

const _shoulder = new THREE.Vector3();
const _hand = new THREE.Vector3();

function flipZ(e: Euler3): Euler3 {
  return [e[0], e[1], -e[2]];
}

/** True when left hand sits clearly above the left shoulder (arms raised). */
export function areArmsRaised(vrm: VRM): boolean {
  const humanoid = vrm.humanoid;
  if (!humanoid) return false;

  const shoulder =
    humanoid.getNormalizedBoneNode("leftShoulder" as never) ??
    humanoid.getNormalizedBoneNode("leftUpperArm" as never);
  const hand =
    humanoid.getNormalizedBoneNode("leftHand" as never) ??
    humanoid.getNormalizedBoneNode("leftLowerArm" as never);
  if (!shoulder || !hand) return false;

  vrm.scene.updateMatrixWorld(true);
  shoulder.getWorldPosition(_shoulder);
  hand.getWorldPosition(_hand);
  return _hand.y > _shoulder.y + 0.08;
}

/**
 * Apply arm pose to normalized humanoid bones.
 * Auto-flips Z if the model ends up with arms raised.
 */
export function applyArmPose(
  vrm: VRM,
  armPose: ArmPose = "natural",
): { bonesFound: number; bonesTotal: number; flippedZ: boolean } {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return { bonesFound: 0, bonesTotal: 6, flippedZ: false };
  }

  humanoid.autoUpdateHumanBones = true;
  const pose = ARM_POSE_EULERS[armPose];

  const write = (negateZ: boolean) => {
    let bonesFound = 0;
    let bonesTotal = 0;
    const setBoneRot = (name: string, euler: Euler3) => {
      bonesTotal++;
      const node = humanoid.getNormalizedBoneNode(name as never);
      if (!node) return;
      const e = negateZ ? flipZ(euler) : euler;
      node.rotation.set(e[0], e[1], e[2]);
      bonesFound++;
    };

    setBoneRot("leftUpperArm", pose.leftUpperArm);
    setBoneRot("rightUpperArm", pose.rightUpperArm);
    setBoneRot("leftLowerArm", pose.leftLowerArm);
    setBoneRot("rightLowerArm", pose.rightLowerArm);
    setBoneRot("leftHand", pose.leftHand);
    setBoneRot("rightHand", pose.rightHand);

    try {
      humanoid.update();
    } catch {
      /* ignore */
    }
    vrm.scene.updateMatrixWorld(true);
    return { bonesFound, bonesTotal };
  };

  const preferFlip = vrm.meta?.metaVersion === "1" && armPose !== "t-pose";
  let { bonesFound, bonesTotal } = write(preferFlip);
  let flippedZ = preferFlip;

  if (armPose !== "t-pose" && bonesFound > 0 && areArmsRaised(vrm)) {
    flippedZ = !preferFlip;
    ({ bonesFound, bonesTotal } = write(flippedZ));
  }

  return { bonesFound, bonesTotal, flippedZ };
}
