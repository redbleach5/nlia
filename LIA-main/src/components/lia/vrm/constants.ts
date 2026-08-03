// ============================================================================
// VRM constants & types — эмоции→цвета, позы рук→кватернионы, типы костей.
// ============================================================================
//
// Вынесено из vrm-avatar.tsx в Phase 2.5 для уменьшения god-file.
// Используется только VrmModel компонентом.

import * as THREE from 'three';
import type { EmotionAxis } from '@/lib/personality';
import type { ArmPose } from '@/lib/avatar-config';

/** Эмоция → цвет подсветки аватара (base + glow). */
export const EMOTION_COLORS: Record<EmotionAxis, { base: string; glow: string }> = {
  joy:        { base: '#d4b89a', glow: '#e8c8a0' },
  curiosity:  { base: '#6a7a90', glow: '#8ba4c4' },
  calm:       { base: '#7a9a6b', glow: '#9ab88a' },
  irritation: { base: '#c2664a', glow: '#d97757' },
  sadness:    { base: '#7a8ba5', glow: '#9aabc0' },
};

// ============================================================================
// Arm pose presets → Euler XYZ для normalized bones (three-vrm).
//
// В normalized T-pose identity = руки горизонтально.
// Базовые знаки ниже — VRM 0.x (leftUpperArm.z > 0 опускает руку).
// Для VRM 1.0 applyArmPose() автоматически инвертирует Z при необходимости.
//
// Имя ARM_POSE_QUATERNIONS историческое — храним Euler-тройки.
// ============================================================================
export const ARM_POSE_QUATERNIONS: Record<ArmPose, {
  leftUpperArm: [number, number, number];   // Euler XYZ в радианах
  rightUpperArm: [number, number, number];
  leftLowerArm: [number, number, number];
  rightLowerArm: [number, number, number];
  leftHand: [number, number, number];
  rightHand: [number, number, number];
}> = {
  natural: {
    leftUpperArm:  [0.05, 0, 1.35],
    rightUpperArm: [0.05, 0, -1.35],
    leftLowerArm:  [-0.25, 0, 0],
    rightLowerArm: [-0.25, 0, 0],
    leftHand:  [0, 0, -0.15],
    rightHand: [0, 0, 0.15],
  },
  relaxed: {
    leftUpperArm:  [0.10, 0, 1.15],
    rightUpperArm: [0.10, 0, -1.15],
    leftLowerArm:  [-0.55, -0.05, 0],
    rightLowerArm: [-0.55, 0.05, 0],
    leftHand:  [0, 0, -0.20],
    rightHand: [0, 0, 0.20],
  },
  't-pose': {
    leftUpperArm:  [0, 0, 0],
    rightUpperArm: [0, 0, 0],
    leftLowerArm:  [0, 0, 0],
    rightLowerArm: [0, 0, 0],
    leftHand:  [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  crossed: {
    leftUpperArm:  [1.20, 0.80, 0.20],
    rightUpperArm: [1.20, -0.80, -0.20],
    leftLowerArm:  [-1.60, 0, -0.60],
    rightLowerArm: [-1.60, 0, 0.60],
    leftHand:  [0, 0, 0],
    rightHand: [0, 0, 0],
  },
  'hands-pockets': {
    leftUpperArm:  [0.20, 0, 0.95],
    rightUpperArm: [0.20, 0, -0.95],
    leftLowerArm:  [-0.85, -0.15, 0],
    rightLowerArm: [-0.85, 0.15, 0],
    leftHand:  [0, 0, -0.30],
    rightHand: [0, 0, 0.30],
  },
};

// Helper: Euler XYZ → quaternion array [x, y, z, w]
export function eulerToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const e = new THREE.Euler(x, y, z, 'XYZ');
  const q = new THREE.Quaternion().setFromEuler(e);
  return [q.x, q.y, q.z, q.w];
}

// ============================================================================
// BoneBases — все базовые rotations/positions для костей, которые мы модифицируем.
// Храним как Euler angles (THREE.Euler), потому что применяем позу через
// bone.rotation.set() и сбрасываем через rotation.copy(). Это согласованный
// подход — нет конфликта между quaternion и Euler.
// ============================================================================
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
