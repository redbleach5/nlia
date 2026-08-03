/**
 * VrmAvatar — VRM presence with layout, arm pose, idle motion, blink.
 *
 * No lip-sync (deferred until TTS / explicit request).
 * Optional `alive` boosts idle intensity while chat/agent streams.
 *
 * Modules ported from LIA-main vrm/*:
 *   layout, arm-pose, expressions, bone bases
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Object3D } from "three";
import { useEffect, useRef, Suspense } from "react";
import { applyVrmLayout, groundVrm } from "./vrm/layout.js";
import { applyArmPose, type ArmPose } from "./vrm/arm-pose.js";
import { ExpressionBinder } from "./vrm/expressions.js";
import { captureBoneBases, createEmptyBases, type BoneBases } from "./vrm/bones.js";

const LOAD_TIMEOUT_MS = 15_000;
const IDLE_FREQUENCY = 1;

export interface VrmAvatarProps {
  /** VRM file URL (e.g. "/api/settings/vrm"). If null, shows placeholder. */
  src?: string | null;
  /** Fill parent container (w-full h-full). Default: fixed size. */
  fill?: boolean;
  /** Fixed size in px (ignored if fill=true). */
  size?: number;
  /** Boost idle motion (e.g. while streaming a reply). No lip-sync. */
  alive?: boolean;
  /** Arm rest pose after load. */
  armPose?: ArmPose;
  /** Called when VRM fails to load. */
  onLoadError?: () => void;
  /** Called when VRM loads successfully. */
  onLoad?: () => void;
}

export function VrmAvatar({
  src,
  fill = false,
  size = 280,
  alive = false,
  armPose = "natural",
  onLoadError,
  onLoad,
}: VrmAvatarProps) {
  if (!src) {
    return <VrmPlaceholder fill={fill} size={size} />;
  }

  return (
    <div
      className={fill ? "w-full h-full min-h-[420px]" : ""}
      style={fill ? { width: "100%", height: "100%", minHeight: 420 } : { width: size, height: size }}
    >
      <Canvas
        camera={{ position: [0, 1.4, 2.2], fov: 30 }}
        gl={{ alpha: true, antialias: true, powerPreference: "default" }}
        dpr={[1, 1.5]}
        style={{ width: "100%", height: "100%", display: "block", background: "transparent" }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        <Suspense fallback={null}>
          <Scene
            src={src}
            alive={alive}
            armPose={armPose}
            onLoadError={onLoadError}
            onLoad={onLoad}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

function Scene({
  src,
  alive,
  armPose,
  onLoadError,
  onLoad,
}: {
  src: string;
  alive: boolean;
  armPose: ArmPose;
  onLoadError?: () => void;
  onLoad?: () => void;
}) {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 5, 2]} intensity={1.2} color="#fff4e6" />
      <directionalLight position={[-3, 2, -1]} intensity={0.4} color="#c8d8ff" />

      <VrmModel
        src={src}
        alive={alive}
        armPose={armPose}
        onLoadError={onLoadError}
        onLoad={onLoad}
      />

      <OrbitControls
        target={[0, 1.35, 0]}
        minDistance={0.8}
        maxDistance={3}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 1.8}
        enablePan={false}
      />
    </>
  );
}

function VrmModel({
  src,
  alive,
  armPose,
  onLoadError,
  onLoad,
}: {
  src: string;
  alive: boolean;
  armPose: ArmPose;
  onLoadError?: () => void;
  onLoad?: () => void;
}) {
  const vrmRef = useRef<VRM | null>(null);
  const binderRef = useRef<ExpressionBinder | null>(null);
  const basesRef = useRef<BoneBases>(createEmptyBases());
  const loadedRef = useRef(false);
  const aliveRef = useRef(alive);
  const { scene } = useThree();

  aliveRef.current = alive;

  const animState = useRef({
    blinkTimer: 1.2 + Math.random() * 2,
    isBlinking: false,
    blinkPhase: 0,
    blinkDuration: 0.15,
    breathPhase: Math.random() * Math.PI * 2,
    swayPhase: Math.random() * Math.PI * 2,
    armPhase: Math.random() * Math.PI * 2,
    weightPhase: Math.random() * Math.PI * 2,
    headPhase: Math.random() * Math.PI * 2,
    fidgetPhase: Math.random() * Math.PI * 2,
    handPhase: Math.random() * Math.PI * 2,
  });

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    const timeoutHandle = window.setTimeout(() => {
      if (cancelled || loadedRef.current) return;
      timedOut = true;
      console.error("[VRM] load timeout");
      onLoadError?.();
    }, LOAD_TIMEOUT_MS);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      src,
      (gltf) => {
        if (cancelled || timedOut) return;
        window.clearTimeout(timeoutHandle);

        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.error("[VRM] not found in glTF");
          onLoadError?.();
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.rotateVRM0(vrm);

        if (vrm.expressionManager) {
          vrm.expressionManager.resetValues();
        }
        binderRef.current = new ExpressionBinder(vrm);

        applyVrmLayout(vrm, { userScale: 1, yOffset: 0 });
        applyArmPose(vrm, armPose);
        groundVrm(vrm, 0);
        captureBoneBases(vrm, basesRef.current);

        scene.add(vrm.scene);
        vrmRef.current = vrm;
        loadedRef.current = true;
        onLoad?.();
      },
      undefined,
      (err) => {
        if (cancelled) return;
        window.clearTimeout(timeoutHandle);
        console.error("[VRM] load error:", err);
        onLoadError?.();
      },
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
      const prev = vrmRef.current;
      if (prev) {
        scene.remove(prev.scene);
        try {
          VRMUtils.deepDispose(prev.scene);
        } catch {
          /* ignore */
        }
      }
      vrmRef.current = null;
      binderRef.current = null;
      loadedRef.current = false;
      basesRef.current = createEmptyBases();
    };
  }, [src, scene, armPose, onLoadError, onLoad]);

  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !loadedRef.current) return;
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    const freq = IDLE_FREQUENCY;
    const b = basesRef.current;
    const life = aliveRef.current ? 1.35 : 1.15;
    const a = animState.current;

    a.breathPhase += delta * 0.95 * freq;
    a.swayPhase += delta * 0.48 * freq;
    a.armPhase += delta * 0.62 * freq;
    a.weightPhase += delta * 0.26 * freq;
    a.headPhase += delta * 0.38 * freq;
    a.fidgetPhase += delta * 0.32 * freq;
    a.handPhase += delta * 0.95 * freq;

    const hips = humanoid.getNormalizedBoneNode("hips" as never);
    const spine = humanoid.getNormalizedBoneNode("spine" as never);
    const chest = humanoid.getNormalizedBoneNode("chest" as never);
    const neck = humanoid.getNormalizedBoneNode("neck" as never);
    const head = humanoid.getNormalizedBoneNode("head" as never);
    const leftShoulder = humanoid.getNormalizedBoneNode("leftShoulder" as never);
    const rightShoulder = humanoid.getNormalizedBoneNode("rightShoulder" as never);
    const leftUpperArm = humanoid.getNormalizedBoneNode("leftUpperArm" as never);
    const rightUpperArm = humanoid.getNormalizedBoneNode("rightUpperArm" as never);
    const leftLowerArm = humanoid.getNormalizedBoneNode("leftLowerArm" as never);
    const rightLowerArm = humanoid.getNormalizedBoneNode("rightLowerArm" as never);
    const leftHand = humanoid.getNormalizedBoneNode("leftHand" as never);
    const rightHand = humanoid.getNormalizedBoneNode("rightHand" as never);
    const leftUpperLeg = humanoid.getNormalizedBoneNode("leftUpperLeg" as never);
    const rightUpperLeg = humanoid.getNormalizedBoneNode("rightUpperLeg" as never);

    const resetRot3 = (
      bone: Object3D | null,
      base: { rotX: number; rotY: number; rotZ: number },
    ) => {
      if (!bone) return;
      bone.rotation.x = base.rotX;
      bone.rotation.y = base.rotY;
      bone.rotation.z = base.rotZ;
    };

    // Reset to bases each frame (absolute = base + delta)
    if (hips) {
      hips.position.x = b.hips.posX;
      hips.position.y = b.hips.posY;
      hips.rotation.x = b.hips.rotX;
      hips.rotation.y = b.hips.rotY;
      hips.rotation.z = b.hips.rotZ;
    }
    resetRot3(spine, b.spine);
    resetRot3(chest, b.chest);
    resetRot3(neck, b.neck);
    resetRot3(head, b.head);
    if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ;
    if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ;
    resetRot3(leftUpperArm, b.leftUpperArm);
    resetRot3(rightUpperArm, b.rightUpperArm);
    resetRot3(leftLowerArm, b.leftLowerArm);
    resetRot3(rightLowerArm, b.rightLowerArm);
    resetRot3(leftHand, b.leftHand);
    resetRot3(rightHand, b.rightHand);
    if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ;
    if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ;

    const breathPrimary = Math.sin(a.breathPhase);
    const breathSecondary = Math.sin(a.breathPhase * 2.17 + 0.6) * 0.35;
    const breath = breathPrimary + breathSecondary;

    // Breathing
    if (spine) {
      spine.rotation.x = b.spine.rotX + breath * 0.045 * life;
      spine.rotation.z = b.spine.rotZ + Math.sin(a.breathPhase * 0.5) * 0.016;
    }
    if (chest) {
      chest.rotation.x = b.chest.rotX + breath * 0.032 * life;
      chest.rotation.y = b.chest.rotY + Math.sin(a.breathPhase * 1.4) * 0.02;
    }
    if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + breath * 0.028;
    if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - breath * 0.028;

    // Body sway
    const sway = Math.sin(a.swayPhase);
    const sway2 = Math.sin(a.swayPhase * 1.63 + 0.8) * 0.45;
    const combined = sway + sway2;
    if (hips) {
      hips.rotation.y = b.hips.rotY + combined * 0.07 * life;
      hips.rotation.z = b.hips.rotZ + Math.sin(a.swayPhase * 0.7) * 0.028;
      hips.position.y = b.hips.posY + Math.sin(a.swayPhase * 2.1) * 0.007;
    }
    if (spine) {
      spine.rotation.y = b.spine.rotY + Math.sin(a.swayPhase + Math.PI) * 0.04 * life;
    }
    if (chest) {
      chest.rotation.z = b.chest.rotZ + combined * 0.02;
    }

    // Weight shift
    const shift = Math.sin(a.weightPhase);
    const shift2 = Math.sin(a.weightPhase * 0.67 + 1.1) * 0.4;
    if (hips) hips.position.x = b.hips.posX + (shift + shift2) * 0.045;
    if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ + shift * 0.04;
    if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ - shift * 0.03;

    // Arm / hand micro-motion
    const armSway1 = Math.sin(a.armPhase) * 0.08 * life;
    const armSway2 = Math.sin(a.armPhase + Math.PI) * 0.08 * life;
    const fidget = Math.sin(a.fidgetPhase);
    if (leftUpperArm) {
      leftUpperArm.rotation.z = b.leftUpperArm.rotZ + armSway1 + fidget * 0.025;
      leftUpperArm.rotation.x = b.leftUpperArm.rotX + Math.sin(a.armPhase * 0.7) * 0.04;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.z = b.rightUpperArm.rotZ + armSway2 - fidget * 0.02;
      rightUpperArm.rotation.x =
        b.rightUpperArm.rotX + Math.sin(a.armPhase * 0.7 + Math.PI) * 0.04;
    }
    if (leftLowerArm) {
      leftLowerArm.rotation.x = b.leftLowerArm.rotX + Math.sin(a.armPhase * 0.5) * 0.035;
      leftLowerArm.rotation.z = b.leftLowerArm.rotZ + Math.sin(a.handPhase) * 0.02;
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.x =
        b.rightLowerArm.rotX + Math.sin(a.armPhase * 0.5 + Math.PI) * 0.035;
      rightLowerArm.rotation.z = b.rightLowerArm.rotZ + Math.sin(a.handPhase + 1.2) * 0.018;
    }
    if (leftHand) {
      leftHand.rotation.z = b.leftHand.rotZ + Math.sin(a.handPhase) * 0.14;
      leftHand.rotation.x = b.leftHand.rotX + Math.sin(a.handPhase * 1.35) * 0.08;
    }
    if (rightHand) {
      rightHand.rotation.z = b.rightHand.rotZ + Math.sin(a.handPhase + Math.PI) * 0.12;
      rightHand.rotation.x = b.rightHand.rotX + Math.sin(a.handPhase * 1.1 + 0.5) * 0.07;
    }
    if (leftShoulder) leftShoulder.rotation.z += Math.sin(a.fidgetPhase * 1.4) * 0.022;
    if (rightShoulder) rightShoulder.rotation.z += Math.sin(a.fidgetPhase * 0.9 + 0.7) * 0.018;

    // Head / neck sway
    if (head) {
      const h1 = Math.sin(a.headPhase);
      const h2 = Math.sin(a.headPhase * 1.71 + 1.3) * 0.55;
      head.rotation.y = b.head.rotY + (h1 + h2) * 0.11 * life;
      head.rotation.x = b.head.rotX + Math.sin(a.headPhase * 0.6) * 0.055;
      head.rotation.z = b.head.rotZ + Math.sin(a.fidgetPhase * 0.55) * 0.04;
    }
    if (neck) {
      neck.rotation.x = b.neck.rotX + Math.sin(a.headPhase * 0.85) * 0.032 * life;
      neck.rotation.y = b.neck.rotY + Math.sin(a.headPhase * 1.2) * 0.025;
    }

    // Blink (random + occasional double)
    const binder = binderRef.current;
    a.blinkTimer -= delta;
    if (!a.isBlinking && a.blinkTimer < 0) {
      a.isBlinking = true;
      a.blinkPhase = 0;
      const isDouble = Math.random() < 0.22;
      a.blinkDuration = isDouble ? 0.35 : 0.13;
    }
    if (a.isBlinking) {
      a.blinkPhase += delta / a.blinkDuration;
      if (a.blinkPhase >= 1) {
        a.isBlinking = false;
        a.blinkTimer = 1.4 + Math.random() * 3.2;
        binder?.set("blink", 0);
      } else {
        let v: number;
        if (a.blinkDuration > 0.25) {
          const half = a.blinkPhase * 2;
          const localPhase = half % 1;
          v = localPhase < 0.5 ? localPhase * 2 : (1 - localPhase) * 2;
        } else {
          v = a.blinkPhase < 0.5 ? a.blinkPhase * 2 : (1 - a.blinkPhase) * 2;
        }
        binder?.set("blink", v);
      }
    }

    try {
      vrm.update(delta);
    } catch {
      /* exotic models */
    }
  });

  return null;
}

/** Placeholder shown when no VRM file is loaded. */
function VrmPlaceholder({ fill, size }: { fill: boolean; size: number }) {
  return (
    <div
      className={`flex items-center justify-center bg-[var(--color-surface)] rounded-[var(--radius-lg)] border border-[var(--color-border-soft)] ${
        fill ? "w-full h-full" : ""
      }`}
      style={!fill ? { width: size, height: size } : undefined}
    >
      <div className="text-center space-y-4 p-6">
        <div className="w-14 h-14 mx-auto rounded-full bg-[var(--color-ember-subtle)] flex items-center justify-center border border-[var(--color-border-soft)]">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--color-ember-deep)]"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
          </svg>
        </div>
        <div className="space-y-1">
          <p className="font-display-italic text-[15px] text-[var(--color-fg-ink)]">Аватар не загружен</p>
          <p className="text-[11px] text-[var(--color-fg-faint)] editorial-label">
            загрузите .vrm в настройки → аватар
          </p>
        </div>
      </div>
    </div>
  );
}
