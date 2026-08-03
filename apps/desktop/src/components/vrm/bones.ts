/**
 * Bone base poses for idle animation (reset each frame, then add deltas).
 * Ported from LIA-main vrm/constants.ts BoneBases.
 */

import type { Object3D } from "three";
import type { VRM } from "@pixiv/three-vrm";

export type BoneBases = {
  hips: { posX: number; posY: number; rotX: number; rotY: number; rotZ: number };
  spine: { rotX: number; rotY: number; rotZ: number };
  chest: { rotX: number; rotY: number; rotZ: number };
  neck: { rotX: number; rotY: number; rotZ: number };
  head: { rotX: number; rotY: number; rotZ: number };
  leftShoulder: { rotZ: number };
  rightShoulder: { rotZ: number };
  leftUpperArm: { rotX: number; rotY: number; rotZ: number };
  rightUpperArm: { rotX: number; rotY: number; rotZ: number };
  leftLowerArm: { rotX: number; rotY: number; rotZ: number };
  rightLowerArm: { rotX: number; rotY: number; rotZ: number };
  leftHand: { rotX: number; rotY: number; rotZ: number };
  rightHand: { rotX: number; rotY: number; rotZ: number };
  leftUpperLeg: { rotZ: number };
  rightUpperLeg: { rotZ: number };
};

export function createEmptyBases(): BoneBases {
  return {
    hips: { posX: 0, posY: 0, rotX: 0, rotY: 0, rotZ: 0 },
    spine: { rotX: 0, rotY: 0, rotZ: 0 },
    chest: { rotX: 0, rotY: 0, rotZ: 0 },
    neck: { rotX: 0, rotY: 0, rotZ: 0 },
    head: { rotX: 0, rotY: 0, rotZ: 0 },
    leftShoulder: { rotZ: 0 },
    rightShoulder: { rotZ: 0 },
    leftUpperArm: { rotX: 0, rotY: 0, rotZ: 0 },
    rightUpperArm: { rotX: 0, rotY: 0, rotZ: 0 },
    leftLowerArm: { rotX: 0, rotY: 0, rotZ: 0 },
    rightLowerArm: { rotX: 0, rotY: 0, rotZ: 0 },
    leftHand: { rotX: 0, rotY: 0, rotZ: 0 },
    rightHand: { rotX: 0, rotY: 0, rotZ: 0 },
    leftUpperLeg: { rotZ: 0 },
    rightUpperLeg: { rotZ: 0 },
  };
}

function saveRot3(
  bone: Object3D | null | undefined,
  target: { rotX: number; rotY: number; rotZ: number },
): void {
  if (!bone) return;
  target.rotX = bone.rotation.x;
  target.rotY = bone.rotation.y;
  target.rotZ = bone.rotation.z;
}

/** Snapshot current bone transforms after layout + arm pose. */
export function captureBoneBases(vrm: VRM, bases: BoneBases): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  const getBone = (name: string) => humanoid.getNormalizedBoneNode(name as never);

  const hips = getBone("hips");
  if (hips) {
    bases.hips.posX = hips.position.x;
    bases.hips.posY = hips.position.y;
    bases.hips.rotX = hips.rotation.x;
    bases.hips.rotY = hips.rotation.y;
    bases.hips.rotZ = hips.rotation.z;
  }
  saveRot3(getBone("spine"), bases.spine);
  saveRot3(getBone("chest"), bases.chest);
  saveRot3(getBone("neck"), bases.neck);
  saveRot3(getBone("head"), bases.head);
  const leftShoulder = getBone("leftShoulder");
  const rightShoulder = getBone("rightShoulder");
  if (leftShoulder) bases.leftShoulder.rotZ = leftShoulder.rotation.z;
  if (rightShoulder) bases.rightShoulder.rotZ = rightShoulder.rotation.z;
  saveRot3(getBone("leftUpperArm"), bases.leftUpperArm);
  saveRot3(getBone("rightUpperArm"), bases.rightUpperArm);
  saveRot3(getBone("leftLowerArm"), bases.leftLowerArm);
  saveRot3(getBone("rightLowerArm"), bases.rightLowerArm);
  saveRot3(getBone("leftHand"), bases.leftHand);
  saveRot3(getBone("rightHand"), bases.rightHand);
  const leftUpperLeg = getBone("leftUpperLeg");
  const rightUpperLeg = getBone("rightUpperLeg");
  if (leftUpperLeg) bases.leftUpperLeg.rotZ = leftUpperLeg.rotation.z;
  if (rightUpperLeg) bases.rightUpperLeg.rotZ = rightUpperLeg.rotation.z;
}
