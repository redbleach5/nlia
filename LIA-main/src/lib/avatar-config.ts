import { z } from 'zod';
// AvatarConfig — конфигурация внешнего вида и поведения VRM-аватара.
//
// Хранится в DB как JSON-строка в Setting.avatar_config.
// Загружается через /api/settings GET, сохраняется через POST.
// Используется в VrmAvatar (3D).

// ============================================================================
// Камера — где находится и куда смотрит
// ============================================================================
export type CameraPreset = 'portrait' | 'fullbody' | 'closeup' | 'custom';

type AvatarCameraConfig = {
  preset: CameraPreset;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

// ============================================================================
// Фон — что за аватаром
// ============================================================================
export type BackgroundStyle = 'transparent' | 'gradient' | 'solid' | 'radial';

type AvatarBackgroundConfig = {
  style: BackgroundStyle;
  color: string;
  edgeColor: string;
};

// ============================================================================
// Освещение — тёплое / холодное / нейтральное
// ============================================================================
export type LightingPreset = 'warm' | 'cool' | 'neutral' | 'soft' | 'dramatic';

type AvatarLightingConfig = {
  preset: LightingPreset;
  intensity: number;
};

// ============================================================================
// Анимации — покой и микро-движения
// ============================================================================
type AvatarAnimationConfig = {
  breathing: boolean;       // дыхание (движение спины)
  blinking: boolean;        // моргание
  headSway: boolean;        // лёгкое покачивание головой
  bodySway: boolean;        // покачивание всем телом (бёдра + плечи)
  armSway: boolean;         // микро-движения рук (как при ходьбе на месте)
  weightShift: boolean;     // перенос веса с ноги на ногу (медленный цикл)
  gazeFollow: boolean;      // взгляд на UI (composer/chat) + idle glance — без курсора
  lipSync: boolean;         // липсинк во время стриминга ответа
  emotionMorph: boolean;    // плавная интерполяция эмоций (happy/sad/angry/...)
  emotionPose: boolean;     // изменения позы под эмоцию (joy → лёгкий наклон, sadness → плечи вниз)
  idleFrequency: number;    // 0.3 - 2.0 — множитель частоты всех idle-анимаций
};

// ============================================================================
// Тело — поза и пропорции
// ============================================================================
export type ArmPose = 'natural' | 'relaxed' | 't-pose' | 'crossed' | 'hands-pockets';

type AvatarBodyConfig = {
  armPose: ArmPose;
  scale: number;
  yOffset: number;
};

// ============================================================================
// Полный конфиг
// ============================================================================
export type AvatarConfig = {
  camera: AvatarCameraConfig;
  background: AvatarBackgroundConfig;
  lighting: AvatarLightingConfig;
  animation: AvatarAnimationConfig;
  body: AvatarBodyConfig;
};

// ============================================================================
// Пресеты камеры — под head ≈ REFERENCE_HEAD_Y (1.45 m) после vrm/layout.
// hips ≈ 1.0, голова ≈ 1.45. Формула: видимая высота ≈ 2 * d * tan(FOV/2).
// ============================================================================
export const CAMERA_PRESETS: Record<Exclude<CameraPreset, 'custom'>, Omit<AvatarCameraConfig, 'preset'>> = {
  portrait: {
    position: [0, 1.32, 1.28],
    target:   [0, 1.22, 0],
    fov: 36,
  },
  fullbody: {
    position: [0, 0.95, 2.55],
    target:   [0, 0.85, 0],
    fov: 46,
  },
  closeup: {
    position: [0, 1.42, 1.05],
    target:   [0, 1.38, 0],
    fov: 30,
  },
};

/** Боковая колонка — лицо в центре узкого кадра. */
const SIDEBAR_CAMERA_PRESETS: Record<Exclude<CameraPreset, 'custom'>, Omit<AvatarCameraConfig, 'preset'>> = {
  portrait: {
    position: [0, 1.36, 1.58],
    target:   [0, 1.28, 0],
    fov: 34,
  },
  fullbody: {
    position: [0, 1.00, 2.85],
    target:   [0, 0.88, 0],
    fov: 46,
  },
  closeup: {
    position: [0, 1.40, 1.22],
    target:   [0, 1.36, 0],
    fov: 28,
  },
};

/** Кружок CompanionPortrait. */
const COMPACT_CAMERA_PRESETS: Record<Exclude<CameraPreset, 'custom'>, Omit<AvatarCameraConfig, 'preset'>> = {
  portrait: {
    position: [0, 1.40, 1.05],
    target:   [0, 1.36, 0],
    fov: 32,
  },
  fullbody: {
    position: [0, 1.36, 1.25],
    target:   [0, 1.28, 0],
    fov: 34,
  },
  closeup: {
    position: [0, 1.42, 0.95],
    target:   [0, 1.40, 0],
    fov: 30,
  },
};

function vecNear(
  a: [number, number, number],
  b: [number, number, number],
  eps = 0.06,
): boolean {
  return Math.abs(a[0] - b[0]) <= eps
    && Math.abs(a[1] - b[1]) <= eps
    && Math.abs(a[2] - b[2]) <= eps;
}

/** Пользователь не менял камеру относительно factory-пресета (или legacy tight portrait). */
function usesFactoryCamera(cam: AvatarCameraConfig): boolean {
  if (cam.preset === 'custom') return false;
  const factory = CAMERA_PRESETS[cam.preset];
  if (vecNear(cam.position, factory.position) && vecNear(cam.target, factory.target)) {
    return Math.abs(cam.fov - factory.fov) <= 1;
  }
  // Legacy: старые portrait-позиции до head-based framing.
  const legacyPortraitPositions: [number, number, number][] = [
    [0, 1.36, 0.72],
    [0, 1.38, 0.82],
    [0, 1.52, 0.58],
    [0, 1.22, 1.12],
    [0, 1.20, 1.42],
    [0, 1.28, 1.18],
  ];
  if (cam.preset === 'portrait' && legacyPortraitPositions.some(p => vecNear(cam.position, p))) {
    return true;
  }
  return false;
}

type ResolvedScenePresentation = {
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  cameraFov: number;
  /** Расстояние камеры до target — для OrbitControls min/max zoom. */
  cameraDistance: number;
  background: AvatarBackgroundConfig;
};

type ScenePresentationOptions = {
  /** Боковая колонка — soft-override factory-камеры. */
  sidebar?: boolean;
  /** Мини-портрет (кружок): soft-override только для factory-пресетов. */
  compact?: boolean;
};

export function cameraDistance(
  position: [number, number, number],
  target: [number, number, number],
): number {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Камера: всегда из config.camera (настройки пользователя).
 *  Sidebar / compact — мягкий override только для factory-пресетов. */
export function resolveScenePresentation(
  config: AvatarConfig,
  options?: ScenePresentationOptions,
): ResolvedScenePresentation {
  const sidebar = options?.sidebar ?? false;
  const compact = options?.compact ?? false;
  const preset = config.camera.preset;

  let cam = config.camera;
  if (compact) {
    // Respect custom / user-tuned camera — only soft-override factory defaults
    // so the circular portrait matches Настройки → Внешний вид.
    if (preset !== 'custom' && usesFactoryCamera(config.camera)) {
      cam = { preset, ...COMPACT_CAMERA_PRESETS[preset] };
    }
  } else if (sidebar && preset !== 'custom' && usesFactoryCamera(config.camera)) {
    cam = { preset, ...SIDEBAR_CAMERA_PRESETS[preset] };
  }

  return {
    cameraPosition: cam.position,
    cameraTarget: cam.target,
    cameraFov: cam.fov,
    cameraDistance: cameraDistance(cam.position, cam.target),
    background: config.background,
  };
}

// ============================================================================
// Значения по умолчанию — подобраны под тему «тёплый лён»
// ============================================================================
export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  camera: {
    preset: 'portrait',
    position: CAMERA_PRESETS.portrait.position,
    target: CAMERA_PRESETS.portrait.target,
    fov: CAMERA_PRESETS.portrait.fov,
  },
  background: {
    style: 'radial',
    color: '#f5f1e8',
    edgeColor: '#fafafa',
  },
  lighting: {
    preset: 'warm',
    intensity: 1.0,
  },
  animation: {
    breathing: true,
    blinking: true,
    headSway: true,
    bodySway: true,
    armSway: true,
    weightShift: true,
    gazeFollow: true,
    lipSync: true,
    emotionMorph: true,
    emotionPose: true,
    idleFrequency: 1.25,
  },
  body: {
    armPose: 'natural',
    scale: 1.0,
    yOffset: 0,
  },
};

// ============================================================================
// Lighting presets — конкретные параметры освещения
// ============================================================================
export const LIGHTING_PRESETS: Record<LightingPreset, {
  ambient: { color: string; intensity: number };
  keyLight: { color: string; intensity: number; position: [number, number, number] };
  fillLight: { color: string; intensity: number; position: [number, number, number] };
  hemisphere?: { sky: string; ground: string; intensity: number };
}> = {
  warm: {
    ambient:     { color: '#ffffff', intensity: 0.85 },
    keyLight:    { color: '#fff5e8', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#e8d5c0', intensity: 0.35, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff5e8', ground: '#c9a886', intensity: 0.25 },
  },
  cool: {
    ambient:     { color: '#f0f4ff', intensity: 0.85 },
    keyLight:    { color: '#e0eaff', intensity: 0.95, position: [1, 3, 2] },
    fillLight:   { color: '#c8d4ff', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#e0eaff', ground: '#a8b4c8', intensity: 0.25 },
  },
  neutral: {
    ambient:     { color: '#ffffff', intensity: 0.9 },
    keyLight:    { color: '#ffffff', intensity: 1.0, position: [1, 3, 2] },
    fillLight:   { color: '#f0f0f0', intensity: 0.4, position: [-1, 2, 1] },
    hemisphere:  { sky: '#ffffff', ground: '#d0d0d0', intensity: 0.2 },
  },
  soft: {
    ambient:     { color: '#ffffff', intensity: 1.1 },
    keyLight:    { color: '#fff8ed', intensity: 0.6, position: [1, 3, 2] },
    fillLight:   { color: '#f0e6d2', intensity: 0.6, position: [-1, 2, 1] },
    hemisphere:  { sky: '#fff8ed', ground: '#d8c8a8', intensity: 0.4 },
  },
  dramatic: {
    ambient:     { color: '#ffffff', intensity: 0.4 },
    keyLight:    { color: '#fff0d8', intensity: 1.4, position: [2, 2.5, 1] },
    fillLight:   { color: '#3a2818', intensity: 0.2, position: [-2, 1, -1] },
    hemisphere:  { sky: '#fff0d8', ground: '#2a1810', intensity: 0.1 },
  },
};

// ============================================================================
// Parser — Zod schema with defaults + legacy field support
// ============================================================================

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const CameraSchema = z.object({
  preset: z.enum(['portrait', 'fullbody', 'closeup', 'custom']).catch('portrait' as const),
  position: vec3.optional(),
  target: vec3.optional(),
  fov: z.number().min(15).max(75).optional(),
}).transform((cam): AvatarCameraConfig => {
  const preset = cam.preset;
  const presetDefaults = preset !== 'custom' ? CAMERA_PRESETS[preset] : DEFAULT_AVATAR_CONFIG.camera;
  return {
    preset,
    position: cam.position ?? presetDefaults.position,
    target: cam.target ?? presetDefaults.target,
    fov: cam.fov ?? presetDefaults.fov,
  };
});

const BackgroundSchema = z.object({
  style: z.enum(['transparent', 'gradient', 'solid', 'radial']).catch('radial' as const),
  color: z.string().optional(),
  edgeColor: z.string().optional(),
}).transform((bg): AvatarBackgroundConfig => ({
  style: bg.style,
  color: bg.color ?? DEFAULT_AVATAR_CONFIG.background.color,
  edgeColor: bg.edgeColor ?? DEFAULT_AVATAR_CONFIG.background.edgeColor,
}));

const LightingSchema = z.object({
  preset: z.enum(['warm', 'cool', 'neutral', 'soft', 'dramatic']).catch('warm' as const),
  intensity: z.number().min(0.4).max(1.8).optional(),
}).transform((lt): AvatarLightingConfig => ({
  preset: lt.preset,
  intensity: lt.intensity ?? DEFAULT_AVATAR_CONFIG.lighting.intensity,
}));

const AnimationSchema = z.object({
  breathing: z.boolean().optional(),
  blinking: z.boolean().optional(),
  headSway: z.boolean().optional(),
  bodySway: z.boolean().optional(),
  armSway: z.boolean().optional(),
  weightShift: z.boolean().optional(),
  gazeFollow: z.boolean().optional(),
  lipSync: z.boolean().optional(),
  emotionMorph: z.boolean().optional(),
  emotionPose: z.boolean().optional(),
  idleFrequency: z.number().min(0.2).max(3).optional(),
}).transform((an): AvatarAnimationConfig => ({
  breathing: an.breathing ?? DEFAULT_AVATAR_CONFIG.animation.breathing,
  blinking: an.blinking ?? DEFAULT_AVATAR_CONFIG.animation.blinking,
  headSway: an.headSway ?? DEFAULT_AVATAR_CONFIG.animation.headSway,
  bodySway: an.bodySway ?? DEFAULT_AVATAR_CONFIG.animation.bodySway,
  armSway: an.armSway ?? DEFAULT_AVATAR_CONFIG.animation.armSway,
  weightShift: an.weightShift ?? DEFAULT_AVATAR_CONFIG.animation.weightShift,
  gazeFollow: an.gazeFollow ?? DEFAULT_AVATAR_CONFIG.animation.gazeFollow,
  lipSync: an.lipSync ?? DEFAULT_AVATAR_CONFIG.animation.lipSync,
  emotionMorph: an.emotionMorph ?? DEFAULT_AVATAR_CONFIG.animation.emotionMorph,
  emotionPose: an.emotionPose ?? DEFAULT_AVATAR_CONFIG.animation.emotionPose,
  idleFrequency: an.idleFrequency ?? DEFAULT_AVATAR_CONFIG.animation.idleFrequency,
}));

const BodySchema = z.object({
  armPose: z.enum(['natural', 'relaxed', 't-pose', 'crossed', 'hands-pockets']).catch('natural' as const),
  scale: z.number().min(0.7).max(1.3).optional(),
  yOffset: z.number().min(-0.3).max(0.3).optional(),
}).transform((bd): AvatarBodyConfig => ({
  armPose: bd.armPose,
  scale: bd.scale ?? DEFAULT_AVATAR_CONFIG.body.scale,
  yOffset: bd.yOffset ?? DEFAULT_AVATAR_CONFIG.body.yOffset,
}));

const AvatarConfigSchema = z.object({
  camera: CameraSchema.optional(),
  // platform — removed; ignore leftover keys from old saved configs
  background: BackgroundSchema.optional(),
  lighting: LightingSchema.optional(),
  animation: AnimationSchema.optional(),
  body: BodySchema.optional(),
}).transform((raw): AvatarConfig => ({
  camera: raw.camera ?? DEFAULT_AVATAR_CONFIG.camera,
  background: raw.background ?? DEFAULT_AVATAR_CONFIG.background,
  lighting: raw.lighting ?? DEFAULT_AVATAR_CONFIG.lighting,
  animation: raw.animation ?? DEFAULT_AVATAR_CONFIG.animation,
  body: raw.body ?? DEFAULT_AVATAR_CONFIG.body,
}));

export function parseAvatarConfig(json: string): AvatarConfig {
  try {
    const raw = JSON.parse(json);
    const parsed = AvatarConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ...DEFAULT_AVATAR_CONFIG };
  } catch {
    return { ...DEFAULT_AVATAR_CONFIG };
  }
}
