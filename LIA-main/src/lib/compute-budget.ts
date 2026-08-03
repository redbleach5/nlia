// ============================================================================
// Compute budget contract (P1) — thin layer over capability-profile.
// ============================================================================
//
// VRAM pool + model roles → headroom (observe / warn).
// Pure functions only — no DB, no Ollama. Detection wires this in
// capability-profile.ts. Do NOT fork chat/agent pipelines here.
//
// Hard rule: budget must not silently choke Lia (no ctx/agent/tier cuts
// from pressure). Pressure is for UI / observe-warn only.

import type { Tier } from '@/lib/capability-profile';

// ============================================================================
// Roles
// ============================================================================

/** Explicit model slots Lia may keep warm. */
export type ModelRole = 'chat' | 'agent' | 'secondary' | 'heavy' | 'embed';

/**
 * Inference ctx residency policy.
 * - day: prefer full-GPU (weights+KV fit pool); shrink ctx before spilling.
 * - heavy: allow mild spill budget (higher effective pool) for hard tasks.
 */
export type InferenceCtxRole = 'day' | 'heavy';

export type RoleModelInput = {
  role: ModelRole;
  /** Resolved model name; null/empty = unset. */
  modelName: string | null;
  parameterSizeB: number;
  quantization: string | null;
  /**
   * When true, this role reuses chat weights (e.g. agent model unset).
   * Does not add a second resident copy.
   */
  sharesChatWeights?: boolean;
};

export type RoleBudgetLine = {
  role: ModelRole;
  modelName: string | null;
  parameterSizeB: number;
  quantization: string | null;
  estimatedVramGb: number;
  sharesChatWeights: boolean;
  /** Counted toward resident VRAM peak. */
  resident: boolean;
};

export type VramPressure = 'comfortable' | 'tight' | 'critical';

export type ComputeBudget = {
  vramPoolGb: number;
  roles: RoleBudgetLine[];
  /** Sum of unique resident models (chat + distinct agent + embed). */
  residentVramGb: number;
  headroomGb: number;
  /** Free fraction of pool (0..1). */
  headroomRatio: number;
  pressure: VramPressure;
};

// ============================================================================
// VRAM estimate
// ============================================================================

/**
 * Rough bytes/param from Ollama quantization label.
 * Intentional over-estimate — safer headroom than optimistic under-fill.
 */
export function bytesPerParamFromQuant(quantization: string | null): number {
  if (!quantization) return 0.55; // assume Q4-ish (common Ollama default)
  const q = quantization.toLowerCase();
  if (/f32|fp32/.test(q)) return 4;
  if (/f16|fp16|bf16/.test(q)) return 2;
  if (/q8|int8/.test(q)) return 1;
  if (/q6/.test(q)) return 0.75;
  if (/q5/.test(q)) return 0.65;
  if (/q4|q3_k_m|iq4/.test(q)) return 0.55;
  if (/q3|iq3/.test(q)) return 0.45;
  if (/q2|iq2/.test(q)) return 0.35;
  return 0.55;
}

/**
 * Estimate resident VRAM for a model (weights + light runtime overhead).
 *
 * Not a profiler — good enough to decide comfortable vs OOM-adjacent.
 * Unknown size → 0 (caller should not invent a giant footprint).
 */
export function estimateModelVramGb(
  parameterSizeB: number,
  quantization: string | null,
): number {
  if (parameterSizeB <= 0) return 0;
  const bytesPerParam = bytesPerParamFromQuant(quantization);
  const weightsGb = parameterSizeB * bytesPerParam;
  // Runtime / KV / allocator overhead — scale lightly with size, floor 0.25 GB
  const overheadGb = Math.max(0.25, parameterSizeB * 0.05);
  return Math.round((weightsGb + overheadGb) * 100) / 100;
}

/** Tiny embed models when Ollama details are missing. */
export function estimateEmbedVramGbFallback(modelName: string | null): number {
  if (!modelName) return 0.4;
  if (/nomic|minilm|e5-small|bge-small/i.test(modelName)) return 0.3;
  if (/bge-m3|e5-large|arctic/i.test(modelName)) return 0.8;
  return 0.5;
}

/**
 * Rough GB of KV cache growth per 1k context tokens.
 * Calibrated from mid-size Q4 residency (~0.01 GB/1k per billion params).
 * Not a profiler — used only to cap num_ctx against the VRAM pool.
 */
export function estimateKvGbPer1kTokens(parameterSizeB: number): number {
  if (parameterSizeB <= 0) return 0.1;
  return Math.max(0.04, parameterSizeB * 0.01);
}

/**
 * Max context tokens that fit the VRAM pool given model weights + headroom.
 *
 * Prefers full-GPU residency for `day`. `heavy` uses a larger effective budget
 * (mild hybrid spill). Returns null when pool/size unknown — caller keeps
 * tier-only cap. Floor is intentional (usable chat); never hardcodes a host SKU.
 *
 * `LIA_INFERENCE_RAM_GB` is reserved for a later hybrid term — not applied here.
 */
export function resolvePoolAwareCtxCap(params: {
  vramPoolGb: number;
  vramPoolKnown: boolean;
  parameterSizeB: number;
  quantization?: string | null;
  role?: InferenceCtxRole;
  /** Embed / other resident reserve (GB). */
  embedReserveGb?: number;
  /** Absolute floor (tokens). */
  minCtx?: number;
}): number | null {
  if (!params.vramPoolKnown || params.vramPoolGb <= 0 || params.parameterSizeB <= 0) {
    return null;
  }

  const role = params.role ?? 'day';
  const weightsGb = estimateModelVramGb(params.parameterSizeB, params.quantization ?? null);
  const embedReserveGb = params.embedReserveGb ?? 0.5;
  // Day: ~92% of pool for model+KV. Heavy: allow ~115% effective (spill into RAM).
  const poolFactor = role === 'heavy' ? 1.15 : 0.92;
  const targetBudgetGb = params.vramPoolGb * poolFactor - embedReserveGb;
  const availableKvGb = targetBudgetGb - weightsGb;
  if (availableKvGb <= 0) {
    return params.minCtx ?? 2048;
  }

  const kvPer1k = estimateKvGbPer1kTokens(params.parameterSizeB);
  const raw = Math.floor((availableKvGb / kvPer1k) * 1000);
  // Quantize to 1024-token steps for stable Ollama KV.
  const stepped = Math.floor(raw / 1024) * 1024;
  const minCtx = params.minCtx ?? 2048;
  return Math.max(minCtx, stepped);
}

// ============================================================================
// Resolve budget from role inputs
// ============================================================================

/**
 * Build compute budget from VRAM pool + per-role model specs.
 *
 * Resident peak (Ollama may keep multiple loaded):
 *   - chat (always, if named)
 *   - agent when distinct from chat
 *   - embed (warmup / memory path)
 * Secondary / heavy are listed but NOT counted as resident peak — they swap in
 * for trivial / escalate turns and are typically not co-resident with day.
 */
export function resolveComputeBudget(params: {
  vramPoolGb: number;
  isCpuOnly?: boolean;
  /**
   * When false (remote Ollama, no LIA_INFERENCE_VRAM_GB), do not invent
   * critical pressure from an empty pool — tier/pressure wait for an override.
   */
  vramPoolKnown?: boolean;
  roles: RoleModelInput[];
}): ComputeBudget {
  const vramPoolKnown = params.vramPoolKnown !== false;
  const vramPoolGb = params.isCpuOnly ? 0 : Math.max(0, params.vramPoolGb);
  const chat = params.roles.find(r => r.role === 'chat');
  const chatName = chat?.modelName?.trim() || null;

  const lines: RoleBudgetLine[] = params.roles.map(r => {
    const name = r.modelName?.trim() || null;
    const shares = r.sharesChatWeights === true
      || (r.role === 'agent' && (!name || (chatName !== null && name === chatName)));

    let estimated = estimateModelVramGb(r.parameterSizeB, r.quantization);
    if (r.role === 'embed' && estimated <= 0) {
      estimated = estimateEmbedVramGbFallback(name);
    }

    // Secondary/heavy: never resident peak; agent sharing chat: not extra copy
    let resident = false;
    if (r.role === 'chat' && name) resident = true;
    if (r.role === 'agent' && name && !shares) resident = true;
    if (r.role === 'embed' && name) resident = true;

    return {
      role: r.role,
      modelName: name,
      parameterSizeB: r.parameterSizeB,
      quantization: r.quantization,
      estimatedVramGb: shares && r.role === 'agent'
        ? (chat ? estimateModelVramGb(chat.parameterSizeB, chat.quantization) : estimated)
        : estimated,
      sharesChatWeights: shares,
      resident,
    };
  });

  // Unique resident models by name — avoid double-counting identical tags
  const seen = new Set<string>();
  let residentVramGb = 0;
  for (const line of lines) {
    if (!line.resident || !line.modelName) continue;
    const key = line.modelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    residentVramGb += line.estimatedVramGb;
  }
  // KV / activations reserve when a chat-sized model is resident — context
  // growth eats VRAM beyond static weights (important on 8–12 GB cards).
  const hasChatResident = lines.some(l => l.role === 'chat' && l.resident);
  if (hasChatResident && vramPoolKnown && vramPoolGb > 0) {
    residentVramGb += Math.min(2, Math.max(1, vramPoolGb * 0.12));
  }
  residentVramGb = Math.round(residentVramGb * 100) / 100;

  const headroomGb = vramPoolKnown
    ? Math.round((vramPoolGb - residentVramGb) * 100) / 100
    : 0;
  const headroomRatio = vramPoolKnown && vramPoolGb > 0
    ? Math.max(0, Math.min(1, headroomGb / vramPoolGb))
    : 0;

  const pressure = classifyVramPressure({
    vramPoolGb,
    headroomGb,
    headroomRatio,
    isCpuOnly: params.isCpuOnly === true,
    vramPoolKnown,
  });

  return {
    vramPoolGb: vramPoolKnown ? vramPoolGb : 0,
    roles: lines,
    residentVramGb,
    headroomGb,
    headroomRatio,
    pressure,
  };
}

export function classifyVramPressure(params: {
  vramPoolGb: number;
  headroomGb: number;
  headroomRatio: number;
  isCpuOnly?: boolean;
  /** Remote Ollama without pool override — do not invent critical. */
  vramPoolKnown?: boolean;
}): VramPressure {
  if (params.vramPoolKnown === false) return 'comfortable';
  if (params.isCpuOnly || params.vramPoolGb <= 0) return 'critical';
  // Absolute floors matter on 8–12 GB cards (two mid-size models = danger)
  if (params.headroomGb < 1 || params.headroomRatio < 0.1) return 'critical';
  if (params.headroomGb < 3 || params.headroomRatio < 0.25) return 'tight';
  return 'comfortable';
}

// ============================================================================
// Tier from model + hardware floor (NOT from VRAM pressure)
// ============================================================================
//
// Owner rule: do not silently choke Lia. Pressure is advisory (UI /
// observe-warn). Tier describes the *chat model size class*, not a
// throttle knob for multi-model VRAM tightness.

const TIER_RANK: Record<Tier, number> = {
  micro: 0,
  standard: 1,
  plus: 2,
  max: 3,
};

export function clampTier(tier: Tier, maxTier: Tier): Tier {
  return TIER_RANK[tier] <= TIER_RANK[maxTier] ? tier : maxTier;
}

/**
 * Tier from model size + hardware floor (CPU / tiny VRAM → micro).
 *
 * Callers pass the role's model size (chat → companion tier, agent → agent tier).
 * Intentionally does **not** demote tier for multi-model pressure or tight fit.
 * Those surface as `budget.pressure` for UI/warnings only — cutting tier would
 * disable monologue/deliberate/agent depth and "suffocate" Lia.
 */
export function classifyTierFromBudget(params: {
  modelSizeB: number;
  vramPoolGb: number;
  gpuCount: number;
  isCpuOnly: boolean;
  /**
   * When false (remote Ollama, VRAM unknown), skip the <8GB → micro floor —
   * tier follows chat model size so a LAN GPU isn't misread as Mac Metal.
   */
  vramPoolKnown?: boolean;
  /** retained for callers / diagnostics — not used to demote tier */
  chatEstimatedVramGb?: number;
  /** retained for callers / diagnostics — not used to demote tier */
  pressure?: VramPressure;
}): Tier {
  const { modelSizeB, vramPoolGb, gpuCount, isCpuOnly } = params;
  const vramPoolKnown = params.vramPoolKnown !== false;

  if (isCpuOnly) {
    return 'micro';
  }
  // Known tiny pool → micro. Unknown remote pool → do not demote.
  if (vramPoolKnown && vramPoolGb < 8) {
    return 'micro';
  }

  if (modelSizeB === 0) {
    if (vramPoolKnown && (vramPoolGb >= 80 || gpuCount >= 2)) return 'max';
    if (vramPoolKnown && vramPoolGb >= 24) return 'plus';
    return 'standard';
  }
  if (modelSizeB <= 4) return 'micro';
  if (modelSizeB <= 13) return 'standard';
  if (modelSizeB <= 32) return 'plus';
  return 'max';
}

// ============================================================================
// VRAM pressure — observe / warn only (never shrink brains)
// ============================================================================
//
// applyHeadroom* helpers were removed: they returned inputs unchanged and
// suggested adaptive compute. Pressure still flows into CapabilityProfile.budget
// for UI warnings; context window and CognitiveParams stay at full strength.
