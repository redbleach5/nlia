'use client';

// ============================================================================
// VrmAvatar — 3D VRM-аватар с эмоциями, дыханием, морганием, lip-sync.
// ============================================================================
//
// Главный компонент. Содержит:
//   - VrmAvatar (thin wrapper: Canvas + BackgroundLayer + Scene)
//   - Scene (lights + VrmModel + OrbitControls)
//   - VrmModel (загрузка VRM + useFrame animation loop)
//
// Вынесено в подмодули vrm/:
//   - vrm/constants.ts   — ARM_POSE_QUATERNIONS, BoneBases, eulerToQuat
//   - vrm/background.tsx — BackgroundLayer
//   - vrm/blendshapes.ts — setExpr, emotionToBlendshapes
//
// VrmModel остаётся здесь, потому что useFrame animation loop тесно связан
// с refs (vrmRef, basesRef, animState) и не может быть легко вынесен без
// проброса всех refs через props.

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useEffect, useRef, useState, Suspense } from 'react';
import type { EmotionVector } from '@/lib/personality';
import {
  DEFAULT_AVATAR_CONFIG,
  LIGHTING_PRESETS,
  resolveScenePresentation,
  type AvatarConfig,
} from '@/lib/avatar-config';
import {
  createEmptyBases,
  type BoneBases,
} from './vrm/constants';
import { BackgroundLayer } from './vrm/background';
import { setExpr, emotionToBlendshapes } from './vrm/blendshapes';
import { ExpressionBinder } from './vrm/expressions';
import { applyVrmLayout, groundVrm } from './vrm/layout';
import { applyArmPose } from './vrm/arm-pose';
import {
  updateGazeTarget,
  applyExpressionGaze,
  ensureVerticalLookAtRange,
} from './vrm/gaze';
import {
  createAttentionState,
  setAttentionLook,
  triggerAttentionGesture,
  tickAttention,
  type AvatarLookAnchor,
} from './vrm/attention';
import { LIA_AVATAR_LOOK, LIA_AVATAR_GESTURE } from '@/lib/avatar-cues';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

type VrmAvatarProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  /** Фиксированный размер (px). Игнорируется если fill=true. */
  size?: number;
  /** Заполнить родительский контейнер (w-full h-full). */
  fill?: boolean;
  src?: string;
  config?: AvatarConfig;
  /** Вызывается когда VRM не удалось загрузить (файл отсутствует/битый). */
  onLoadError?: () => void;
  /** Боковая колонка — фиксированный ракурс, узкий zoom, без внутреннего кольца. */
  sidebar?: boolean;
  /** Мини-портрет — кадр на лицо (для узкой колонки). */
  compact?: boolean;
};

export function VrmAvatar({
  emotion,
  speaking = false,
  size = 280,
  fill = false,
  src,
  config = DEFAULT_AVATAR_CONFIG,
  onLoadError,
  sidebar = false,
  compact = false,
}: VrmAvatarProps) {
  // Нет src — не подставляем DEFAULT (иначе 404 /models/lia_v2.vrm на каждый mount).
  if (!src) {
    return null;
  }

  const presentation = resolveScenePresentation(config, { sidebar, compact });
  const sceneConfig: AvatarConfig = {
    ...config,
    background: presentation.background,
  };
  const isPortrait = compact
    || config.camera.preset === 'portrait'
    || config.camera.preset === 'closeup';
  const d = presentation.cameraDistance;
  const zoomTight = (sidebar || compact) && isPortrait;
  const orbitMin = d * (zoomTight ? 0.94 : isPortrait ? 0.88 : 0.82);
  const orbitMax = d * (zoomTight ? 1.06 : isPortrait ? 1.12 : 1.18);

  return (
    <div
      className={fill ? 'relative w-full h-full' : 'relative'}
      style={fill ? undefined : { width: size, height: size }}
    >
      {!sidebar && !compact && (
        <BackgroundLayer background={sceneConfig.background} edgeToEdge={fill} />
      )}
      <Canvas
        className={fill ? 'w-full h-full' : undefined}
        camera={{
          position: presentation.cameraPosition,
          fov: presentation.cameraFov,
        }}
        gl={{ alpha: sidebar || compact || sceneConfig.background.style === 'transparent', antialias: true }}
        dpr={[1, 2]}
      >
        <Suspense fallback={null}>
          <Scene
            emotion={emotion}
            speaking={speaking}
            src={src}
            config={sceneConfig}
            cameraPosition={presentation.cameraPosition}
            cameraTarget={presentation.cameraTarget}
            cameraFov={presentation.cameraFov}
            orbitMin={orbitMin}
            orbitMax={orbitMax}
            lockRotation={sidebar || compact}
            onLoadError={onLoadError}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

/** Синхронизирует PerspectiveCamera + OrbitControls при смене пресета/FOV. */
function CameraRig({
  position,
  target,
  fov,
  orbitMin,
  orbitMax,
  lockRotation,
}: {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  orbitMin: number;
  orbitMax: number;
  lockRotation?: boolean;
}) {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    if (camera instanceof THREE.PerspectiveCamera) {
      // React's hook immutability rule disallows assigning to a value returned
      // by useThree. Three exposes a mutation method for the same operation.
      const focalLength = 0.5 * camera.getFilmHeight()
        / Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
      camera.setFocalLength(focalLength);
      camera.updateProjectionMatrix();
    }
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(target[0], target[1], target[2]);
      controls.minDistance = orbitMin;
      controls.maxDistance = orbitMax;
      controls.update();
    }
  }, [
    camera,
    position[0], position[1], position[2],
    target[0], target[1], target[2],
    fov, orbitMin, orbitMax,
  ]);

  return (
    <OrbitControls
      ref={controlsRef}
      target={target}
      enablePan={false}
      enableRotate={!lockRotation}
      enableZoom={!lockRotation}
      minDistance={orbitMin}
      maxDistance={orbitMax}
      minPolarAngle={Math.PI / 6}
      maxPolarAngle={Math.PI / 2.02}
      minAzimuthAngle={lockRotation ? 0 : -Math.PI / 5}
      maxAzimuthAngle={lockRotation ? 0 : Math.PI / 5}
      enableDamping
      dampingFactor={0.08}
    />
  );
}

// ============================================================================
// Scene — lights + VrmModel + OrbitControls
// ============================================================================
function Scene({
  emotion,
  speaking,
  src,
  config,
  cameraPosition,
  cameraTarget,
  cameraFov,
  orbitMin,
  orbitMax,
  lockRotation,
  onLoadError,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  cameraFov: number;
  orbitMin: number;
  orbitMax: number;
  lockRotation?: boolean;
  onLoadError?: () => void;
}) {
  const lights = LIGHTING_PRESETS[config.lighting.preset];
  const lightScale = config.lighting.intensity;

  return (
    <>
      <ambientLight intensity={lights.ambient.intensity * lightScale} color={lights.ambient.color} />
      <directionalLight
        position={lights.keyLight.position}
        intensity={lights.keyLight.intensity * lightScale}
        color={lights.keyLight.color}
      />
      <directionalLight
        position={lights.fillLight.position}
        intensity={lights.fillLight.intensity * lightScale}
        color={lights.fillLight.color}
      />
      {lights.hemisphere && (
        <hemisphereLight
          args={[lights.hemisphere.sky, lights.hemisphere.ground, lights.hemisphere.intensity * lightScale]}
        />
      )}

      <VrmModel emotion={emotion} speaking={speaking} src={src} config={config} onLoadError={onLoadError} />

      <CameraRig
        position={cameraPosition}
        target={cameraTarget}
        fov={cameraFov}
        orbitMin={orbitMin}
        orbitMax={orbitMax}
        lockRotation={lockRotation}
      />
    </>
  );
}

// ============================================================================
// VrmModel — загрузка VRM + все idle-анимации
// ============================================================================
function VrmModel({
  emotion,
  speaking,
  src,
  config,
  onLoadError,
}: {
  emotion: EmotionVector;
  speaking: boolean;
  src: string;
  config: AvatarConfig;
  onLoadError?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const exprBinderRef = useRef<ExpressionBinder | null>(null);
  const gazeTargetRef = useRef(new THREE.Object3D());
  const basesRef = useRef<BoneBases>(createEmptyBases());
  const loadedRef = useRef(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const onLoadErrorCalledRef = useRef(false);

  // ── Загрузка VRM + применение позы + сохранение баз ──
  useEffect(() => {
    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    // Локальные флаги для timeout-проверки — state (loaded/loadFailed) был бы stale
    // в замыкании setTimeout из-за пустого deps array.
    let localLoaded = false;
    let localFailed = false;
    setLoadFailed(false);
    loadedRef.current = false;
    onLoadErrorCalledRef.current = false;

    // Drop previous model immediately when src/pose changes (avoid double-draw / leaks).
    if (vrmRef.current) {
      try {
        if (vrmRef.current.lookAt) vrmRef.current.lookAt.target = null;
        VRMUtils.deepDispose(vrmRef.current.scene);
      } catch { /* ignore */ }
      vrmRef.current = null;
      exprBinderRef.current = null;
      if (groupRef.current) {
        while (groupRef.current.children.length > 0) {
          groupRef.current.remove(groupRef.current.children[0]);
        }
      }
    }

    // ── Страховочный timeout: если VRM не загрузился за 15 сек — считаем что failed.
    // Решает проблему когда GLTFLoader молчит (например, при сетевых проблемах,
    // или когда сервер отдаёт HTML 404 вместо бинарника, и loader пытается парсить).
    timeoutHandle = setTimeout(() => {
      if (cancelled) return;
      if (!localLoaded && !localFailed) {
        console.warn('[VRM] Load timeout (15s) — treating as failed');
        localFailed = true;
        setLoadFailed(true);
        if (!onLoadErrorCalledRef.current) {
          onLoadErrorCalledRef.current = true;
          onLoadError?.();
        }
      }
    }, 15000);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      src,
      (gltf) => {
        if (cancelled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        localLoaded = true;
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          console.error('[VRM] No VRM in gltf');
          localFailed = true;
          setLoadFailed(true);
          if (!onLoadErrorCalledRef.current) {
            onLoadErrorCalledRef.current = true;
            onLoadError?.();
          }
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);

        // VRM 0.x: face −Z → rotate 180°. VRM 1.0: no-op. Always use the official helper.
        const metaVersion = vrm.meta?.metaVersion;
        const modelName = metaVersion === '1'
          ? (vrm.meta as { name?: string }).name
          : (vrm.meta as { title?: string }).title;
        VRMUtils.rotateVRM0(vrm);
        console.warn(`[VRM] Loaded VRM ${metaVersion ?? '?'} "${modelName ?? 'unknown'}"`);

        if (vrm.expressionManager) {
          vrm.expressionManager.resetValues();
        }
        exprBinderRef.current = new ExpressionBinder(vrm);
        const supported = exprBinderRef.current.supported();
        if (supported.length < 4) {
          console.warn(`[VRM] Few expression presets (${supported.join(', ') || 'none'}) — emotions/blink may be limited`);
        }

        // Normalize by head bone (not full bbox — hair/T-pose skew height).
        const layout = applyVrmLayout(vrm, {
          userScale: config.body.scale,
          yOffset: config.body.yOffset,
        });
        console.warn(
          `[VRM] Layout: rawHeadY=${layout.rawHeadY.toFixed(3)} → ×${layout.normalizeScale.toFixed(3)}, `
          + `headY=${layout.headY.toFixed(3)}, hipsY=${layout.hipsY.toFixed(3)}`,
        );

        // Arm pose, then re-ground (arms down can change bbox slightly).
        const poseResult = applyArmPose(vrm, config.body.armPose);
        groundVrm(vrm, config.body.yOffset);
        if (poseResult.bonesFound < poseResult.bonesTotal) {
          console.warn(`[VRM] Arm pose: ${poseResult.bonesFound}/${poseResult.bonesTotal} bones found. ` +
            `Model may be non-humanoid. Arms will stay in default position.`);
        } else if (poseResult.flippedZ) {
          console.warn('[VRM] Arm pose Z flipped for this model (VRM1 / raised-arm detect)');
        }

        if (groupRef.current) {
          while (groupRef.current.children.length > 0) {
            const child = groupRef.current.children[0];
            groupRef.current.remove(child);
          }
          groupRef.current.add(vrm.scene);
          const gazeTarget = gazeTargetRef.current;
          if (gazeTarget.parent) gazeTarget.parent.remove(gazeTarget);
          groupRef.current.add(gazeTarget);
        }
        vrmRef.current = vrm;

        if (vrm.lookAt) {
          vrm.lookAt.autoUpdate = true;
          vrm.lookAt.target = gazeTargetRef.current;
          // VRoid Bone lookAt: вертикальный yRange ≈10° — почти незаметен; поднимаем floor.
          ensureVerticalLookAtRange(vrm);
        }

        // ── Сохраняем базы ВСЕХ костей как Euler angles ──
        const humanoidForBones = vrm.humanoid;
        if (humanoidForBones) {
          const getBone = (name: string) => humanoidForBones.getNormalizedBoneNode(name as never);
          const hips = getBone('hips');
          const spine = getBone('spine');
          const chest = getBone('chest');
          const neck = getBone('neck');
          const head = getBone('head');
          const leftShoulder = getBone('leftShoulder');
          const rightShoulder = getBone('rightShoulder');
          const leftUpperArm = getBone('leftUpperArm');
          const rightUpperArm = getBone('rightUpperArm');
          const leftLowerArm = getBone('leftLowerArm');
          const rightLowerArm = getBone('rightLowerArm');
          const leftHand = getBone('leftHand');
          const rightHand = getBone('rightHand');
          const leftUpperLeg = getBone('leftUpperLeg');
          const rightUpperLeg = getBone('rightUpperLeg');

          const saveRot3 = (bone: THREE.Object3D | null, target: { rotX: number; rotY: number; rotZ: number }) => {
            if (!bone) return;
            target.rotX = bone.rotation.x;
            target.rotY = bone.rotation.y;
            target.rotZ = bone.rotation.z;
          };

          const b = basesRef.current;
          if (hips) {
            b.hips.posX = hips.position.x;
            b.hips.posY = hips.position.y;
            b.hips.rotX = hips.rotation.x;
            b.hips.rotY = hips.rotation.y;
            b.hips.rotZ = hips.rotation.z;
          }
          saveRot3(spine, b.spine);
          saveRot3(chest, b.chest);
          saveRot3(neck, b.neck);
          saveRot3(head, b.head);
          if (leftShoulder) b.leftShoulder.rotZ = leftShoulder.rotation.z;
          if (rightShoulder) b.rightShoulder.rotZ = rightShoulder.rotation.z;
          saveRot3(leftUpperArm, b.leftUpperArm);
          saveRot3(rightUpperArm, b.rightUpperArm);
          saveRot3(leftLowerArm, b.leftLowerArm);
          saveRot3(rightLowerArm, b.rightLowerArm);
          saveRot3(leftHand, b.leftHand);
          saveRot3(rightHand, b.rightHand);
          if (leftUpperLeg) b.leftUpperLeg.rotZ = leftUpperLeg.rotation.z;
          if (rightUpperLeg) b.rightUpperLeg.rotZ = rightUpperLeg.rotation.z;
        }

        loadedRef.current = true;
      },
      undefined,
      (err) => {
        if (cancelled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        console.error('[VRM] load failed:', err);
        localFailed = true;
        setLoadFailed(true);
        if (!onLoadErrorCalledRef.current) {
          onLoadErrorCalledRef.current = true;
          onLoadError?.();
        }
      },
    );

    return () => {
      cancelled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const prev = vrmRef.current;
      if (prev?.lookAt) {
        prev.lookAt.target = null;
      }
      if (prev) {
        try {
          VRMUtils.deepDispose(prev.scene);
        } catch {
          /* ignore dispose errors on exotic meshes */
        }
      }
      vrmRef.current = null;
      exprBinderRef.current = null;
      loadedRef.current = false;
      basesRef.current = createEmptyBases();
    };
  }, [src, config.body.armPose, config.body.scale, config.body.yOffset, onLoadError]);

  // ── Состояние анимаций ──
  const animState = useRef({
    blinkTimer: 1.2 + Math.random() * 2,
    isBlinking: false,
    blinkPhase: 0,
    blinkDuration: 0.15,
    mouthPhase: 0,
    mouthValue: 0,
    current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 } as Record<string, number>,
    breathPhase: Math.random() * Math.PI * 2,
    swayPhase: Math.random() * Math.PI * 2,
    armPhase: Math.random() * Math.PI * 2,
    weightPhase: Math.random() * Math.PI * 2,
    headPhase: Math.random() * Math.PI * 2,
    fidgetPhase: Math.random() * Math.PI * 2,
    handPhase: Math.random() * Math.PI * 2,
  });
  const attentionRef = useRef(createAttentionState());

  // UI cues → look / gesture (no mouse tracking)
  useEffect(() => {
    const onLook = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        anchor?: AvatarLookAnchor;
        x?: number;
        y?: number;
        holdSec?: number;
      } | undefined;
      if (!d) return;
      if (d.anchor) {
        setAttentionLook(attentionRef.current, d.anchor, d.holdSec ?? 2.8);
      } else if (typeof d.x === 'number' && typeof d.y === 'number') {
        setAttentionLook(attentionRef.current, { x: d.x, y: d.y }, d.holdSec ?? 2.8);
      }
    };
    const onGesture = (e: Event) => {
      const kind = (e as CustomEvent).detail?.kind;
      if (kind === 'nod' || kind === 'acknowledge') {
        triggerAttentionGesture(attentionRef.current, kind);
      }
    };
    window.addEventListener(LIA_AVATAR_LOOK, onLook);
    window.addEventListener(LIA_AVATAR_GESTURE, onGesture);
    return () => {
      window.removeEventListener(LIA_AVATAR_LOOK, onLook);
      window.removeEventListener(LIA_AVATAR_GESTURE, onGesture);
    };
  }, []);

  const { camera } = useThree();

  // ── Главный цикл анимации ──
  // АРХИТЕКТУРА: каждый кадр начинаем с базовых значений, потом накладываем
  // все активные анимации как absolute = base + delta. Никаких += !
  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm || !loadedRef.current) return;
    const humanoid = vrm.humanoid;
    if (!humanoid) return;
    const cfg = config.animation;
    const freq = cfg.idleFrequency;
    const b = basesRef.current;
    const t = performance.now() / 1000;
    // Живее в покое + чуть активнее от curiosity/joy; speaking — ещё заметнее.
    const moodLife = 1
      + emotion.curiosity * 0.22
      + emotion.joy * 0.18
      - emotion.sadness * 0.12;
    const life = (speaking ? 1.45 : 1.2) * Math.max(0.85, moodLife);

    // Накапливаем фазы (несоизмеримые частоты → менее «роботизированный» цикл)
    animState.current.breathPhase += delta * 0.95 * freq;
    animState.current.swayPhase += delta * 0.48 * freq;
    animState.current.armPhase += delta * 0.62 * freq;
    animState.current.weightPhase += delta * 0.26 * freq;
    animState.current.headPhase += delta * 0.38 * freq;
    animState.current.fidgetPhase += delta * 0.32 * freq;
    animState.current.handPhase += delta * 0.95 * freq;

    const attention = tickAttention(attentionRef.current, delta, {
      enableIdleGlance: cfg.gazeFollow,
    });

    const hips = humanoid.getNormalizedBoneNode('hips' as never);
    const spine = humanoid.getNormalizedBoneNode('spine' as never);
    const chest = humanoid.getNormalizedBoneNode('chest' as never);
    const neck = humanoid.getNormalizedBoneNode('neck' as never);
    const head = humanoid.getNormalizedBoneNode('head' as never);
    const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder' as never);
    const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder' as never);
    const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm' as never);
    const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm' as never);
    const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm' as never);
    const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm' as never);
    const leftHand = humanoid.getNormalizedBoneNode('leftHand' as never);
    const rightHand = humanoid.getNormalizedBoneNode('rightHand' as never);
    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg' as never);
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg' as never);

    const resetRot3 = (
      bone: THREE.Object3D | null,
      base: { rotX: number; rotY: number; rotZ: number },
    ) => {
      if (!bone) return;
      bone.rotation.x = base.rotX;
      bone.rotation.y = base.rotY;
      bone.rotation.z = base.rotZ;
    };

    // ── Шаг 1: сброс ВСЕХ модифицируемых костей к базе (Euler) ──
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

    const breathPrimary = Math.sin(animState.current.breathPhase);
    const breathSecondary = Math.sin(animState.current.breathPhase * 2.17 + 0.6) * 0.35;
    const breath = breathPrimary + breathSecondary;

    // ── Шаг 2: дыхание ──
    if (cfg.breathing) {
      if (spine) {
        spine.rotation.x = b.spine.rotX + breath * 0.045 * life;
        spine.rotation.z = b.spine.rotZ + Math.sin(animState.current.breathPhase * 0.5) * 0.016;
      }
      if (chest) {
        chest.rotation.x = b.chest.rotX + breath * 0.032 * life;
        chest.rotation.y = b.chest.rotY + Math.sin(animState.current.breathPhase * 1.4) * 0.02;
      }
      if (leftShoulder) leftShoulder.rotation.z = b.leftShoulder.rotZ + breath * 0.028;
      if (rightShoulder) rightShoulder.rotation.z = b.rightShoulder.rotZ - breath * 0.028;
    }

    // ── Шаг 3: покачивание телом ──
    if (cfg.bodySway) {
      const sway = Math.sin(animState.current.swayPhase);
      const sway2 = Math.sin(animState.current.swayPhase * 1.63 + 0.8) * 0.45;
      const combined = sway + sway2;
      if (hips) {
        hips.rotation.y = b.hips.rotY + combined * 0.07 * life;
        hips.rotation.z = b.hips.rotZ + Math.sin(animState.current.swayPhase * 0.7) * 0.028;
        hips.position.y = b.hips.posY + Math.sin(animState.current.swayPhase * 2.1) * 0.007;
      }
      if (spine) {
        spine.rotation.y = b.spine.rotY + Math.sin(animState.current.swayPhase + Math.PI) * 0.04 * life;
      }
      if (chest) {
        chest.rotation.z = b.chest.rotZ + combined * 0.02;
      }
    }

    // ── Шаг 4: перенос веса ──
    if (cfg.weightShift) {
      const shift = Math.sin(animState.current.weightPhase);
      const shift2 = Math.sin(animState.current.weightPhase * 0.67 + 1.1) * 0.4;
      if (hips) hips.position.x = b.hips.posX + (shift + shift2) * 0.045;
      if (leftUpperLeg) leftUpperLeg.rotation.z = b.leftUpperLeg.rotZ + shift * 0.04;
      if (rightUpperLeg) rightUpperLeg.rotation.z = b.rightUpperLeg.rotZ - shift * 0.03;
    }

    // ── Шаг 5: микро-движения рук + кисти ──
    if (cfg.armSway) {
      const armSway1 = Math.sin(animState.current.armPhase) * 0.08 * life;
      const armSway2 = Math.sin(animState.current.armPhase + Math.PI) * 0.08 * life;
      const fidget = Math.sin(animState.current.fidgetPhase);
      if (leftUpperArm) {
        leftUpperArm.rotation.z = b.leftUpperArm.rotZ + armSway1 + fidget * 0.025;
        leftUpperArm.rotation.x = b.leftUpperArm.rotX + Math.sin(animState.current.armPhase * 0.7) * 0.04;
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.z = b.rightUpperArm.rotZ + armSway2 - fidget * 0.02;
        rightUpperArm.rotation.x = b.rightUpperArm.rotX + Math.sin(animState.current.armPhase * 0.7 + Math.PI) * 0.04;
      }
      if (leftLowerArm) {
        leftLowerArm.rotation.x = b.leftLowerArm.rotX + Math.sin(animState.current.armPhase * 0.5) * 0.035;
        leftLowerArm.rotation.z = b.leftLowerArm.rotZ + Math.sin(animState.current.handPhase) * 0.02;
      }
      if (rightLowerArm) {
        rightLowerArm.rotation.x = b.rightLowerArm.rotX + Math.sin(animState.current.armPhase * 0.5 + Math.PI) * 0.035;
        rightLowerArm.rotation.z = b.rightLowerArm.rotZ + Math.sin(animState.current.handPhase + 1.2) * 0.018;
      }
      if (leftHand) {
        leftHand.rotation.z = b.leftHand.rotZ + Math.sin(animState.current.handPhase) * 0.14;
        leftHand.rotation.x = b.leftHand.rotX + Math.sin(animState.current.handPhase * 1.35) * 0.08;
      }
      if (rightHand) {
        rightHand.rotation.z = b.rightHand.rotZ + Math.sin(animState.current.handPhase + Math.PI) * 0.12;
        rightHand.rotation.x = b.rightHand.rotX + Math.sin(animState.current.handPhase * 1.1 + 0.5) * 0.07;
      }
      if (leftShoulder) leftShoulder.rotation.z += Math.sin(animState.current.fidgetPhase * 1.4) * 0.022;
      if (rightShoulder) rightShoulder.rotation.z += Math.sin(animState.current.fidgetPhase * 0.9 + 0.7) * 0.018;
    }

    // ── Шаг 6: покачивание головой (до emotion/gaze — они аддитивны сверху) ──
    if (cfg.headSway && head) {
      const h1 = Math.sin(animState.current.headPhase);
      const h2 = Math.sin(animState.current.headPhase * 1.71 + 1.3) * 0.55;
      head.rotation.y = b.head.rotY + (h1 + h2) * 0.11 * life;
      head.rotation.x = b.head.rotX + Math.sin(animState.current.headPhase * 0.6) * 0.055;
      head.rotation.z = b.head.rotZ + Math.sin(animState.current.fidgetPhase * 0.55) * 0.04;
    }
    if (cfg.headSway && neck) {
      neck.rotation.x = b.neck.rotX + Math.sin(animState.current.headPhase * 0.85) * 0.032 * life;
      neck.rotation.y = b.neck.rotY + Math.sin(animState.current.headPhase * 1.2) * 0.025;
    }

    // ── Шаг 7: эмоциональная поза (additive — не затирает breathing/sway/arms) ──
    if (cfg.emotionPose) {
      if (emotion.joy > 0.6 && hips) {
        const bounce = Math.sin(t * 2.5) * 0.015 * (emotion.joy - 0.5);
        hips.position.y += bounce;
      }
      if (emotion.sadness > 0.4) {
        const intensity = (emotion.sadness - 0.3) * 0.5;
        if (spine) spine.rotation.x += intensity * 0.08;
        if (head) head.rotation.x += intensity * 0.1;
        if (leftShoulder) leftShoulder.rotation.z += intensity * 0.05;
        if (rightShoulder) rightShoulder.rotation.z -= intensity * 0.05;
      }
      if (emotion.irritation > 0.4) {
        const intensity = (emotion.irritation - 0.3) * 0.5;
        if (head) head.rotation.x -= intensity * 0.06;
        if (leftUpperArm) leftUpperArm.rotation.z -= intensity * 0.04;
        if (rightUpperArm) rightUpperArm.rotation.z += intensity * 0.04;
      }
      if (emotion.curiosity > 0.6 && head) {
        const intensity = (emotion.curiosity - 0.5) * 0.3;
        head.rotation.z += Math.sin(t * 0.4) * intensity * 0.08;
      }
      if (emotion.calm > 0.6) {
        const intensity = (emotion.calm - 0.5) * 0.2;
        if (leftShoulder) leftShoulder.rotation.z -= intensity * 0.03;
        if (rightShoulder) rightShoulder.rotation.z += intensity * 0.03;
      }
    }

    // ── Шаг 8: gaze к UI / idle glance + жесты (без слежения за курсором) ──
    if (cfg.gazeFollow && head) {
      const offset = { x: attention.gazeX, y: attention.gazeY };
      if (vrm.lookAt) {
        updateGazeTarget(gazeTargetRef.current, head, camera, offset);
      } else {
        applyExpressionGaze(vrm, offset, exprBinderRef.current);
      }
      head.rotation.y += attention.headYaw;
      head.rotation.x += attention.headPitch;
      head.rotation.z += attention.headRoll;
    } else if (head) {
      head.rotation.y += attention.headYaw;
      head.rotation.x += attention.headPitch;
      head.rotation.z += attention.headRoll;
    }

    const binder = exprBinderRef.current;

    // ── Шаг 9: моргание ──
    if (cfg.blinking) {
      animState.current.blinkTimer -= delta;
      if (!animState.current.isBlinking && animState.current.blinkTimer < 0) {
        animState.current.isBlinking = true;
        animState.current.blinkPhase = 0;
        const isDouble = Math.random() < 0.22;
        animState.current.blinkDuration = isDouble ? 0.35 : 0.13;
      }
      if (animState.current.isBlinking) {
        animState.current.blinkPhase += delta / animState.current.blinkDuration;
        if (animState.current.blinkPhase >= 1) {
          animState.current.isBlinking = false;
          animState.current.blinkTimer = 1.4 + Math.random() * 3.2;
          setExpr(vrm, 'blink', 0, binder);
        } else {
          let v;
          if (animState.current.blinkDuration > 0.25) {
            const half = animState.current.blinkPhase * 2;
            const localPhase = half % 1;
            v = localPhase < 0.5 ? localPhase * 2 : (1 - localPhase) * 2;
          } else {
            v = animState.current.blinkPhase < 0.5
              ? animState.current.blinkPhase * 2
              : (1 - animState.current.blinkPhase) * 2;
          }
          setExpr(vrm, 'blink', v, binder);
        }
      }
    }

    // ── Шаг 10: эмоции (blendshapes) ──
    if (cfg.emotionMorph) {
      const target = emotionToBlendshapes(emotion);
      const lerp = 1 - Math.pow(0.001, delta);
      for (const key of Object.keys(target) as Array<keyof typeof target>) {
        if (key === 'aa') continue;
        const cur = animState.current.current[key] as number;
        const tgt = target[key];
        animState.current.current[key] = cur + (tgt - cur) * lerp;
        setExpr(vrm, key, animState.current.current[key], binder);
      }
    }

    // ── Шаг 11: липсинк ──
    if (cfg.lipSync && speaking) {
      animState.current.mouthPhase += delta * 12;
      const target = (Math.sin(animState.current.mouthPhase) + 1) / 2 * 0.5;
      animState.current.mouthValue = THREE.MathUtils.lerp(animState.current.mouthValue, target, 0.3);
    } else {
      animState.current.mouthValue = Math.max(0, animState.current.mouthValue - delta * 2);
    }
    setExpr(vrm, 'aa', animState.current.mouthValue, binder);

    try {
      vrm.update(delta);
    } catch (e) {
      console.error('[VRM] vrm.update() failed:', e);
    }
  });

  if (loadFailed) {
    return (
      <group position={[0, 1.2, 0]}>
        <mesh>
          <sphereGeometry args={[0.15, 16, 16]} />
          <meshStandardMaterial color="#c9a886" />
        </mesh>
      </group>
    );
  }

  return <group ref={groupRef} />;
}
