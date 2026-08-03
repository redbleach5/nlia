// ============================================================================
// Arm pose — apply Euler presets + auto-correct Z sign across VRM0/1.
// ============================================================================
//
// Presets in constants.ts were tuned on VRM 0.x (leftUpperArm.z > 0 lowers arm).
// On many VRM 1.0 normalized rigs the Z axis is mirrored → same values raise
// arms straight up. We detect that via world positions and flip Z once.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { ArmPose } from '@/lib/avatar-config';
import { ARM_POSE_QUATERNIONS } from './constants';

const _shoulder = new THREE.Vector3();
const _hand = new THREE.Vector3();

type Euler3 = [number, number, number];

function flipZ(e: Euler3): Euler3 {
  return [e[0], e[1], -e[2]];
}

/** True when left hand sits clearly above the left shoulder (arms raised). */
export function areArmsRaised(vrm: VRM): boolean {
  const humanoid = vrm.humanoid;
  if (!humanoid) return false;

  const shoulder = humanoid.getNormalizedBoneNode('leftShoulder' as never)
    ?? humanoid.getNormalizedBoneNode('leftUpperArm' as never);
  const hand = humanoid.getNormalizedBoneNode('leftHand' as never)
    ?? humanoid.getNormalizedBoneNode('leftLowerArm' as never);
  if (!shoulder || !hand) return false;

  vrm.scene.updateMatrixWorld(true);
  shoulder.getWorldPosition(_shoulder);
  hand.getWorldPosition(_hand);
  // Raised: hand above shoulder. Down along body: hand well below.
  return _hand.y > _shoulder.y + 0.08;
}

/**
 * Apply arm pose to normalized humanoid bones.
 * For non-T poses, auto-flips Z if the model ends up with arms raised.
 */
export function applyArmPose(vrm: VRM, armPose: ArmPose): { bonesFound: number; bonesTotal: number; flippedZ: boolean } {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return { bonesFound: 0, bonesTotal: 6, flippedZ: false };
  }

  humanoid.autoUpdateHumanBones = true;
  const pose = ARM_POSE_QUATERNIONS[armPose];

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

    setBoneRot('leftUpperArm', pose.leftUpperArm);
    setBoneRot('rightUpperArm', pose.rightUpperArm);
    setBoneRot('leftLowerArm', pose.leftLowerArm);
    setBoneRot('rightLowerArm', pose.rightLowerArm);
    setBoneRot('leftHand', pose.leftHand);
    setBoneRot('rightHand', pose.rightHand);

    try {
      humanoid.update();
    } catch {
      /* ignore */
    }
    vrm.scene.updateMatrixWorld(true);
    return { bonesFound, bonesTotal };
  };

  // Prefer VRM1 inverted Z first — matches current shipping lia.vrm and most VRoid 1.0.
  const preferFlip = vrm.meta?.metaVersion === '1' && armPose !== 't-pose';
  let { bonesFound, bonesTotal } = write(preferFlip);
  let flippedZ = preferFlip;

  if (armPose !== 't-pose' && bonesFound > 0 && areArmsRaised(vrm)) {
    flippedZ = !preferFlip;
    ({ bonesFound, bonesTotal } = write(flippedZ));
  }

  return { bonesFound, bonesTotal, flippedZ };
}
