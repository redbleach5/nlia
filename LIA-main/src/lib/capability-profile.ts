// Capability Profile — detect available compute + model size, classify into tier.
//
// Tier system (4 levels):
//   micro    — ≤4B parameters, or CPU-only, or <8GB VRAM
//   standard — 5-13B parameters, 8-24GB VRAM (tools/maxTokens by complexity)
//   plus     — 14-32B parameters, 24-80GB VRAM
//   max      — 33B+ parameters, multi-GPU or 80GB+ VRAM
//
// Profile is cached in DB (Setting table) with 1-hour TTL.
// VRAM pressure is observe/warn only — never shrinks context or cognitive budgets.
// Depth flags (deliberate) live in cognitive-depth.ts EXECUTION_MATRIX.

import { db } from '@/lib/db';
import { checkOllamaHealth } from '@/lib/ollama';
import {
  classifyTierFromBudget,
  estimateModelVramGb,
  resolveComputeBudget,
  type ComputeBudget,
  type VramPressure,
} from '@/lib/compute-budget';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { logger } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================
export type Tier = 'micro' | 'standard' | 'plus' | 'max';

/** Compact budget snapshot embedded in the capability profile (P1). */
export type CapabilityBudgetSnapshot = {
  residentVramGb: number;
  headroomGb: number;
  headroomRatio: number;
  pressure: VramPressure;
  /** Model-reported context before headroom clamp. */
  modelContextWindow: number;
  roles: Array<{
    role: ComputeBudget['roles'][number]['role'];
    modelName: string | null;
    estimatedVramGb: number;
    sharesChatWeights: boolean;
    resident: boolean;
    /** Params/quant for pool-aware num_ctx when escalating to this role. */
    parameterSizeB?: number;
    quantization?: string | null;
  }>;
};

export type CapabilityProfile = {
  /**
   * Chat-role tier (companion cognitive depth, deliberate/self-check matrix).
   * Derived from the chat model size — never from the agent model.
   */
  tier: Tier;
  modelSize: number;           // in billions (7 = 7B) — chat model
  modelName: string;           // chat model
  /**
   * Agent-role tier (ReAct maxSteps / duration / phase maxTokens).
   * Derived from the agent model when configured; otherwise equals `tier`.
   * Optional on legacy cache entries — use resolveAgentTier().
   */
  agentTier?: Tier;
  /** Agent model size in billions; equals modelSize when agent shares chat. */
  agentModelSize?: number;
  /** Resolved agent model name (chat name when agent slot empty). */
  agentModelName?: string;
  /**
   * Configured heavy model (escalate). Null/absent when unset.
   * Size/quant used for pool-aware num_ctx on heavy calls — not day/agent size.
   */
  heavyModelName?: string | null;
  heavyModelSize?: number;
  heavyQuantization?: string | null;
  quantization: string | null; // 'q4_K_M', 'f16', etc. — chat model
  vramGb: number;              // total VRAM available (0 if CPU-only / unknown)
  gpuCount: number;            // 0 if CPU-only
  gpuName: string | null;
  isCpuOnly: boolean;
  /**
   * Where `vramGb` came from. Optional on legacy cache entries.
   * - local-gpu: nvidia-smi / Metal on the Next host (Ollama loopback)
   * - inference-override: `LIA_INFERENCE_VRAM_GB` for remote Ollama
   * - inference-unknown: remote Ollama, pool not set — do not use UI GPU
   * - cpu-only: local Ollama, no GPU detected
   */
  vramSource?: 'local-gpu' | 'inference-override' | 'inference-unknown' | 'cpu-only';
  /**
   * Model context window in tokens (from Ollama). Callers use this as-is —
   * VRAM pressure must not silently shrink it (P1 observe-only).
   * Raw copy also in budget.modelContextWindow when present.
   */
  contextWindow: number;
  /** P1 — optional on legacy cache entries (pre-budget). */
  budget?: CapabilityBudgetSnapshot;
  detectedAt: number;          // timestamp
  source: 'live' | 'cached';   // was this freshly detected or from cache?
};

export type CognitiveParams = {
  // How many LLM calls for a standard message
  calls: 1 | 2 | 3 | 4;
  // Whether to use deliberate step (analyze before respond) — permanently unused in chat
  deliberate: boolean;
  // Whether to run self-check (re-read answer, fix errors)
  selfCheck: boolean;
  // Max tokens per response
  maxTokens: number;
  // Whether tools are available
  toolsEnabled: boolean;
  // Agent limits
  agentMaxSteps: number;
  agentMaxDurationSec: number;
};

// ============================================================================
// Cache
// ============================================================================
const CACHE_KEY = 'capability_profile';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Fill agentTier fields missing from pre-dual-tier cache entries. */
export function normalizeCapabilityProfile(profile: CapabilityProfile): CapabilityProfile {
  return {
    ...profile,
    agentTier: profile.agentTier ?? profile.tier,
    agentModelSize: profile.agentModelSize ?? profile.modelSize,
    agentModelName: profile.agentModelName ?? profile.modelName,
  };
}

/** Agent budget tier — falls back to chat tier on legacy profiles. */
export function resolveAgentTier(profile: CapabilityProfile | null | undefined): Tier {
  if (!profile) return 'standard';
  return profile.agentTier ?? profile.tier ?? 'standard';
}

async function getCachedProfile(): Promise<CapabilityProfile | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: CACHE_KEY } });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as CapabilityProfile;
    if (Date.now() - parsed.detectedAt > CACHE_TTL_MS) return null;
    return normalizeCapabilityProfile({ ...parsed, source: 'cached' });
  } catch {
    return null;
  }
}

async function setCachedProfile(profile: CapabilityProfile): Promise<void> {
  try {
    await db.setting.upsert({
      where: { key: CACHE_KEY },
      create: { key: CACHE_KEY, value: JSON.stringify(profile) },
      update: { value: JSON.stringify(profile) },
    });
  } catch (e) {
    logger.warn('system', 'Failed to cache capability profile', {}, e);
  }
}

// ============================================================================
// Detection
// ============================================================================

/** Where the VRAM pool number was resolved from. */
export type VramPoolSource =
  | 'local-gpu'
  | 'inference-override'
  | 'inference-unknown'
  | 'cpu-only';

/**
 * True when Ollama is on this machine (loopback). Remote LAN URL → false.
 * Malformed URL fails open to local (safer than inventing remote).
 */
export function isOllamaLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    // Node keeps brackets on IPv6 literals (`[::1]`); browsers may strip them.
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]';
  } catch {
    return true;
  }
}

/** Parse `LIA_INFERENCE_VRAM_GB` — positive finite number or null. */
export function parseInferenceVramGb(raw: string | undefined | null): number | null {
  if (raw == null || !String(raw).trim()) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Resolve VRAM pool for budget/tier.
 *
 * PRIORITIES: UI-машина ≠ мозг — when Ollama is remote, never use Next-host
 * Metal/`nvidia-smi` as the pool. Owner sets `LIA_INFERENCE_VRAM_GB` for the
 * inference box (e.g. `12` for a 12 GB card).
 */
export function resolveVramPool(params: {
  ollamaBaseUrl: string;
  inferenceVramGbEnv?: string | null;
  localGpu: { count: number; vramGb: number; name: string | null } | null;
}): {
  vramGb: number;
  gpuCount: number;
  gpuName: string | null;
  isCpuOnly: boolean;
  vramPoolKnown: boolean;
  vramSource: VramPoolSource;
} {
  if (isOllamaLoopback(params.ollamaBaseUrl)) {
    if (!params.localGpu) {
      return {
        vramGb: 0,
        gpuCount: 0,
        gpuName: null,
        isCpuOnly: true,
        vramPoolKnown: true,
        vramSource: 'cpu-only',
      };
    }
    return {
      vramGb: params.localGpu.vramGb,
      gpuCount: params.localGpu.count,
      gpuName: params.localGpu.name,
      isCpuOnly: false,
      vramPoolKnown: true,
      vramSource: 'local-gpu',
    };
  }

  const override = parseInferenceVramGb(params.inferenceVramGbEnv);
  if (override != null) {
    return {
      vramGb: override,
      gpuCount: 1,
      gpuName: `inference host (${override} GB)`,
      isCpuOnly: false,
      vramPoolKnown: true,
      vramSource: 'inference-override',
    };
  }

  return {
    vramGb: 0,
    gpuCount: 1,
    gpuName: 'inference host (задайте LIA_INFERENCE_VRAM_GB)',
    isCpuOnly: false,
    vramPoolKnown: false,
    vramSource: 'inference-unknown',
  };
}

/**
 * Detect GPU info via nvidia-smi (Linux/Windows) or system_profiler (macOS).
 * Returns null if no GPU detected (true CPU-only).
 *
 * Phase 7.2: конвертирован из execSync (блокировал event loop до 15s) в async execFile.
 * GPU не меняется во время работы — кэшируем результат навсегда.
 *
 * macOS: Apple Silicon (M1/M2/M3) uses Metal via unified memory.
 * We detect this via `system_profiler SPDisplaysDataType` and report
 * VRAM as half of total system RAM (conservative estimate for ML workload).
 *
 * Only used when Ollama is loopback — remote brains use resolveVramPool.
 */
// Вечный кэш — GPU не меняется между запросами
let gpuCache: { count: number; vramGb: number; name: string | null } | null | undefined;

async function detectGpu(): Promise<{ count: number; vramGb: number; name: string | null } | null> {
  if (gpuCache !== undefined) return gpuCache;
  gpuCache = await detectGpuUncached();
  return gpuCache;
}

async function detectGpuUncached(): Promise<{ count: number; vramGb: number; name: string | null } | null> {
  // ── 1. Try nvidia-smi (Linux/Windows with NVIDIA GPU) ──
  try {
    const { stdout: countStr } = await execFileAsync('nvidia-smi', ['--query-gpu=count', '--format=csv,noheader,nounits'], { timeout: 5000 });
    const count = parseInt(countStr.trim().split('\n')[0], 10) || 0;
    if (count === 0) throw new Error('no GPUs');

    const { stdout: vramStr } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 });
    const vramMb = vramStr
      .trim()
      .split('\n')
      .reduce((sum, line) => sum + (parseInt(line.trim(), 10) || 0), 0);
    const vramGb = vramMb / 1024;

    const { stdout: nameStr } = await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    const name = nameStr.trim().split('\n')[0] || null;

    return { count, vramGb, name };
  } catch {
    // nvidia-smi not available — fall through to macOS detection
  }

  // ── 2. Try macOS detection (Apple Silicon / Intel Mac with GPU) ──
  if (process.platform === 'darwin') {
    try {
      const { stdout: output } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 5000 });
      const data = JSON.parse(output);
      const gpus = data?.SPDisplaysDataType ?? [];
      if (gpus.length === 0) return null;

      const gpu = gpus[0];
      const name = gpu?.sppci_model ?? 'Apple GPU';
      const isAppleSilicon = /apple/i.test(name) || /m[1-4]/i.test(name);

      if (isAppleSilicon) {
        // Apple Silicon — unified memory. Get total RAM via sysctl.
        let vramGb = 8; // default fallback
        try {
          const { stdout: memStr } = await execFileAsync('sysctl', ['-n', 'hw.memsize'], { timeout: 5000 });
          const memBytes = parseInt(memStr.trim(), 10);
          vramGb = memBytes / (1024 * 1024 * 1024);
        } catch { /* use fallback */ }

        // Conservative: use half of total RAM as "VRAM" for ML
        return {
          count: 1,
          vramGb: vramGb / 2,
          name: `${name} (${vramGb.toFixed(0)} GB unified)`,
        };
      }

      // Intel Mac with discrete GPU (AMD/NVIDIA)
      const vramStr = gpu?.sppci_vram ?? gpu?.['sppci_vram-shared'] ?? '';
      const vramMatch = vramStr.match(/(\d+)\s*GB/i);
      const vramGb = vramMatch ? parseInt(vramMatch[1], 10) : 4;
      return { count: 1, vramGb, name };
    } catch {
      // system_profiler failed — treat as CPU-only
    }
  }

  return null;
}

/**
 * Parse parameter size from Ollama model details.
 * Returns size in billions (7 = 7B, 70 = 70B).
 */
function parseParameterSize(paramSize: string | undefined): number {
  if (!paramSize) return 0;
  // Format: "7B", "13B", "70B", "1.5B", "0.5B"
  const match = paramSize.match(/([\d.]+)\s*B/i);
  if (!match) return 0;
  return parseFloat(match[1]);
}

/**
 * Fetch model details from Ollama /api/show.
 *
 * Returns parameter size, quantization, and context window.
 * Context window is extracted from `model_info.<architecture>.context_length`
 * (e.g. `llama.context_length`, `gemma.context_length`). The architecture key
 * varies by model family, so we scan for any key ending in `.context_length`.
 */
async function fetchModelDetails(modelName: string): Promise<{
  parameterSize: number;
  quantization: string | null;
  contextWindow: number;
}> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { parameterSize: 0, quantization: null, contextWindow: 0 };
    const data = await res.json();
    const details = data?.details ?? {};
    const modelInfo = (data?.model_info ?? {}) as Record<string, unknown>;
    const contextWindow = extractContextWindow(modelInfo);
    return {
      parameterSize: parseParameterSize(details.parameter_size),
      quantization: details.quantization_level ?? null,
      contextWindow,
    };
  } catch {
    return { parameterSize: 0, quantization: null, contextWindow: 0 };
  }
}

/**
 * Extract context window length from Ollama model_info.
 *
 * Ollama returns model_info as a flat object with architecture-prefixed keys:
 *   - `llama.context_length` (Llama, Qwen, Mistral family)
 *   - `gemma.context_length` (Gemma family)
 *   - `phi3.context_length` (Phi-3 family)
 *   - `command_r.context_length` (Cohere Command R)
 *
 * We scan for any `*.context_length` key. If multiple match (shouldn't happen
 * in practice), we take the max — some models report both a base and extended
 * context length.
 */
function extractContextWindow(modelInfo: Record<string, unknown>): number {
  let max = 0;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > max) {
      max = value;
    }
  }
  return max;
}

/**
 * Read configured model role names from Setting / env (no ollama import cycle).
 */
async function readModelRoleNames(): Promise<{
  chat: string;
  agent: string;
  secondary: string | null;
  heavy: string | null;
  embed: string;
}> {
  let chat = process.env.OLLAMA_MODEL || '';
  let agent = process.env.OLLAMA_AGENT_MODEL || '';
  let embed = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  let secondary: string | null = null;
  let heavy: string | null = null;

  try {
    const rows = await db.setting.findMany({
      where: {
        key: {
          in: [
            'ollama_model',
            'ollama_agent_model',
            'ollama_embed_model',
            'ollama_secondary_model',
            'ollama_heavy_model',
          ],
        },
      },
    });
    for (const row of rows) {
      if (row.key === 'ollama_model' && row.value) chat = row.value;
      else if (row.key === 'ollama_agent_model') agent = row.value;
      else if (row.key === 'ollama_embed_model' && row.value) embed = row.value;
      else if (row.key === 'ollama_secondary_model') {
        const v = row.value?.trim();
        secondary = v || null;
      } else if (row.key === 'ollama_heavy_model') {
        const v = row.value?.trim();
        heavy = v || null;
      }
    }
  } catch { /* ignore */ }

  if (!heavy) {
    const fromEnv = process.env.OLLAMA_HEAVY_MODEL?.trim();
    if (fromEnv) heavy = fromEnv;
  }

  return { chat, agent, secondary, heavy, embed };
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Get capability profile — from cache or freshly detected.
 * If forceRefresh, ignores cache.
 */
export async function getCapabilityProfile(forceRefresh = false): Promise<CapabilityProfile | null> {
  if (!forceRefresh) {
    const cached = await getCachedProfile();
    if (cached) return cached;
  }
  return detectProfile();
}

/**
 * Detect profile from scratch — queries Ollama + nvidia-smi.
 * Resolves all model roles and VRAM headroom (P1 budget contract).
 */
export async function detectProfile(): Promise<CapabilityProfile | null> {
  const health = await checkOllamaHealth();
  if (!health.ok || health.models.length === 0) {
    return null;
  }

  const roleNames = await readModelRoleNames();
  let modelName = roleNames.chat;
  if (!modelName) modelName = health.models[0];

  const agentNameRaw = roleNames.agent.trim();
  const agentSharesChat = !agentNameRaw || agentNameRaw === modelName;
  const agentName = agentSharesChat ? modelName : agentNameRaw;
  const embedName = roleNames.embed || 'nomic-embed-text';
  const secondaryName = roleNames.secondary;
  const heavyName = roleNames.heavy;

  // Fetch details for each distinct model name (parallel)
  const namesToFetch = [...new Set(
    [modelName, agentName, embedName, secondaryName, heavyName].filter((n): n is string => !!n),
  )];
  const detailsEntries = await Promise.all(
    namesToFetch.map(async name => [name, await fetchModelDetails(name)] as const),
  );
  const detailsByName = new Map(detailsEntries);

  const chatDetails = detailsByName.get(modelName) ?? {
    parameterSize: 0, quantization: null, contextWindow: 0,
  };
  const agentDetails = detailsByName.get(agentName) ?? chatDetails;
  const embedDetails = detailsByName.get(embedName) ?? {
    parameterSize: 0, quantization: null, contextWindow: 0,
  };
  const secondaryDetails = secondaryName
    ? (detailsByName.get(secondaryName) ?? {
      parameterSize: 0, quantization: null, contextWindow: 0,
    })
    : null;
  const heavyDetails = heavyName
    ? (detailsByName.get(heavyName) ?? {
      parameterSize: 0, quantization: null, contextWindow: 0,
    })
    : null;

  // VRAM pool follows the Ollama host, not the UI machine (PRIORITIES topology).
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const localGpu = isOllamaLoopback(ollamaBaseUrl) ? await detectGpu() : null;
  const pool = resolveVramPool({
    ollamaBaseUrl,
    inferenceVramGbEnv: process.env.LIA_INFERENCE_VRAM_GB,
    localGpu,
  });
  if (pool.vramSource === 'inference-unknown') {
    logger.warn(
      'system',
      'Remote Ollama without LIA_INFERENCE_VRAM_GB — VRAM pool unknown; tier from model size only',
      { ollamaBaseUrl },
    );
  }
  const { vramGb, gpuCount, gpuName, isCpuOnly, vramPoolKnown, vramSource } = pool;

  const budget = resolveComputeBudget({
    vramPoolGb: vramGb,
    isCpuOnly,
    vramPoolKnown,
    roles: [
      {
        role: 'chat',
        modelName,
        parameterSizeB: chatDetails.parameterSize,
        quantization: chatDetails.quantization,
      },
      {
        role: 'agent',
        modelName: agentNameRaw || null,
        parameterSizeB: agentDetails.parameterSize,
        quantization: agentDetails.quantization,
        sharesChatWeights: agentSharesChat,
      },
      {
        role: 'secondary',
        modelName: secondaryName,
        parameterSizeB: secondaryDetails?.parameterSize ?? 0,
        quantization: secondaryDetails?.quantization ?? null,
      },
      {
        role: 'heavy',
        modelName: heavyName,
        parameterSizeB: heavyDetails?.parameterSize ?? 0,
        quantization: heavyDetails?.quantization ?? null,
      },
      {
        role: 'embed',
        modelName: embedName,
        parameterSizeB: embedDetails.parameterSize,
        quantization: embedDetails.quantization,
      },
    ],
  });

  const chatEstimatedVramGb = estimateModelVramGb(
    chatDetails.parameterSize,
    chatDetails.quantization,
  );

  // Observe-only: day + heavy both huge is a warning, never cuts budgets.
  if (heavyName && heavyDetails && chatEstimatedVramGb > 0 && vramPoolKnown && vramGb > 0) {
    const heavyEst = estimateModelVramGb(
      heavyDetails.parameterSize,
      heavyDetails.quantization,
    );
    if (heavyEst > 0 && chatEstimatedVramGb + heavyEst > vramGb * 0.95) {
      logger.warn('system', 'Day + heavy models likely exceed VRAM pool (observe only)', {
        chatEstimatedVramGb,
        heavyEstimatedVramGb: heavyEst,
        vramGb,
        chat: modelName,
        heavy: heavyName,
      });
    }
  }

  const tierClassifyBase = {
    vramPoolGb: vramGb,
    gpuCount,
    isCpuOnly,
    vramPoolKnown,
    pressure: budget.pressure,
  } as const;

  const tier = classifyTierFromBudget({
    ...tierClassifyBase,
    modelSizeB: chatDetails.parameterSize,
    chatEstimatedVramGb,
  });

  const agentTier = classifyTierFromBudget({
    ...tierClassifyBase,
    modelSizeB: agentDetails.parameterSize,
    chatEstimatedVramGb: estimateModelVramGb(
      agentDetails.parameterSize,
      agentDetails.quantization,
    ),
  });

  const modelContextWindow = chatDetails.contextWindow;
  // VRAM pressure is observe/warn only — never shrink context under pressure.
  const effectiveContextWindow = modelContextWindow > 0 ? modelContextWindow : 0;

  const budgetSnapshot: CapabilityBudgetSnapshot = {
    residentVramGb: budget.residentVramGb,
    headroomGb: budget.headroomGb,
    headroomRatio: budget.headroomRatio,
    pressure: budget.pressure,
    modelContextWindow,
    roles: budget.roles.map(r => ({
      role: r.role,
      modelName: r.modelName,
      estimatedVramGb: r.estimatedVramGb,
      sharesChatWeights: r.sharesChatWeights,
      resident: r.resident,
      parameterSizeB: r.parameterSizeB,
      quantization: r.quantization,
    })),
  };

  const profile: CapabilityProfile = {
    tier,
    modelSize: chatDetails.parameterSize,
    modelName,
    agentTier,
    agentModelSize: agentDetails.parameterSize,
    agentModelName: agentName,
    heavyModelName: heavyName,
    heavyModelSize: heavyDetails?.parameterSize ?? 0,
    heavyQuantization: heavyDetails?.quantization ?? null,
    quantization: chatDetails.quantization,
    vramGb,
    gpuCount,
    gpuName,
    isCpuOnly,
    vramSource,
    contextWindow: effectiveContextWindow,
    budget: budgetSnapshot,
    detectedAt: Date.now(),
    source: 'live',
  };

  logger.info('system', 'Capability profile detected', {
    tier: profile.tier,
    agentTier: profile.agentTier,
    model: profile.modelName,
    agentModel: profile.agentModelName,
    modelSize: profile.modelSize,
    agentModelSize: profile.agentModelSize,
    vramGb: profile.vramGb,
    vramSource,
    pressure: budget.pressure,
    residentVramGb: budget.residentVramGb,
    headroomGb: budget.headroomGb,
    contextWindow: profile.contextWindow,
    modelContextWindow,
  });

  await setCachedProfile(profile);
  return profile;
}

/**
 * Force re-detect after model role changes (settings save).
 * Best-effort — never throws to callers.
 */
export async function refreshCapabilityAfterModelChange(): Promise<CapabilityProfile | null> {
  try {
    return await detectProfile();
  } catch (e) {
    logger.warn('system', 'Capability refresh after model change failed', {}, e);
    return null;
  }
}

// ============================================================================
// Cognitive parameters per tier
// ============================================================================
const TIER_PARAMS: Record<Tier, CognitiveParams> = {
  micro: {
    calls: 1,
    deliberate: false,
    selfCheck: false,
    maxTokens: 2048,
    toolsEnabled: true,
    agentMaxSteps: 10,
    agentMaxDurationSec: 600,         // 10 min
  },
  standard: {
    calls: 2,
    // Matrix enables deliberate for complex+research only
    // (latency tradeoff on trivial/simple/moderate — see cognitive-depth.ts).
    deliberate: true,
    selfCheck: false, // streaming cannot revise; see shouldSelfCheck
    maxTokens: 4096,
    toolsEnabled: true,
    agentMaxSteps: 25,
    agentMaxDurationSec: 3600,        // 1 hour
  },
  plus: {
    calls: 3,
    deliberate: true,       // analyze before respond on complex tasks
    selfCheck: false,
    maxTokens: 8192,
    toolsEnabled: true,
    agentMaxSteps: 100,
    agentMaxDurationSec: 6 * 3600,    // 6 hours
  },
  max: {
    calls: 4,
    deliberate: true,
    selfCheck: false,
    maxTokens: 16384,       // no practical limit
    toolsEnabled: true,
    agentMaxSteps: 500,
    agentMaxDurationSec: 24 * 3600,   // 24 hours
  },
};

/**
 * Get cognitive parameters for the chat role (companion depth).
 * If no profile available, returns 'standard' defaults.
 * P1: VRAM pressure is observe/warn only — never cuts budgets.
 *
 * Agent ReAct limits must use getAgentCognitiveParams() — they follow
 * agentTier when chat and agent models differ in size.
 */
export async function getCognitiveParams(): Promise<{ profile: CapabilityProfile | null; params: CognitiveParams }> {
  const profile = await getCapabilityProfile();
  const tier = profile?.tier ?? 'standard';
  // VRAM pressure is observe/warn only — full tier budgets always.
  const params = TIER_PARAMS[tier];
  return { profile, params };
}

/**
 * Cognitive params for the agent role (maxSteps / duration / phase tokens).
 * Uses agentTier when a larger (or smaller) agent model is configured.
 */
export async function getAgentCognitiveParams(): Promise<{
  profile: CapabilityProfile | null;
  params: CognitiveParams;
  agentTier: Tier;
}> {
  const profile = await getCapabilityProfile();
  const agentTier = resolveAgentTier(profile);
  const params = TIER_PARAMS[agentTier];
  return { profile, params, agentTier };
}

/**
 * Get tier parameters directly (for testing/preview).
 */
export function getTierParams(tier: Tier): CognitiveParams {
  return TIER_PARAMS[tier];
}

// ============================================================================
// Description for UI
// ============================================================================
export const TIER_DESCRIPTIONS: Record<Tier, { label: string; description: string; color: string }> = {
  micro: {
    label: 'Микро',
    description: 'Маленькая модель (≤4B) или CPU. Lia использует поиск в интернете для сложных вопросов.',
    color: 'text-accent-3',
  },
  standard: {
    label: 'Стандарт',
    description: 'Средняя модель (5-13B) с GPU. Подходит для большинства задач.',
    color: 'text-accent-2',
  },
  plus: {
    label: 'Плюс',
    description: 'Большая модель (14-32B). Глубокий анализ, deliberate, self-check.',
    color: 'text-accent',
  },
  max: {
    label: 'Максимум',
    description: 'Очень большая модель (33B+) на мощном железе. Полная когнитивная глубина, без лимитов.',
    color: 'text-foreground',
  },
};
