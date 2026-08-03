import 'server-only';

// Shared pool-aware num_ctx for chat + agent Ollama calls.

import {
  getCapabilityProfile,
  resolveAgentTier,
  type CapabilityProfile,
  type Tier,
} from '@/lib/capability-profile';
import {
  resolveInferenceNumCtx,
  type PoolAwareCtxInput,
} from '@/lib/chat/context-budget';
import type { InferenceCtxRole } from '@/lib/compute-budget';
import { setOllamaNumCtx } from '@/lib/ollama';
import { logger } from '@/lib/logger';

/** True when profile has a real VRAM pool (not remote-unknown). */
export function profileVramPoolKnown(profile: CapabilityProfile | null | undefined): boolean {
  if (!profile) return false;
  if (profile.vramSource === 'inference-unknown') return false;
  if (profile.vramSource === 'cpu-only') return true;
  if (profile.vramSource === 'local-gpu' || profile.vramSource === 'inference-override') {
    return true;
  }
  // Legacy cache without vramSource
  return profile.vramGb > 0;
}

/**
 * Size/quant for the model that will actually run (day vs heavy).
 * Heavy escalate must use heavy weights — not day/agent — or num_ctx thrashs VRAM.
 */
export function modelSpecsForCtxRole(
  profile: CapabilityProfile | null | undefined,
  ctxRole: InferenceCtxRole,
  kind: 'chat' | 'agent' = 'chat',
): { parameterSizeB: number; quantization: string | null } {
  if (ctxRole === 'heavy') {
    const fromProfile = profile?.heavyModelSize ?? 0;
    if (fromProfile > 0) {
      return {
        parameterSizeB: fromProfile,
        quantization: profile?.heavyQuantization ?? null,
      };
    }
    const line = profile?.budget?.roles?.find(r => r.role === 'heavy');
    if (line && (line.parameterSizeB ?? 0) > 0) {
      return {
        parameterSizeB: line.parameterSizeB!,
        quantization: line.quantization ?? null,
      };
    }
    // Heavy configured but size unknown — stay conservative (treat as large).
    return { parameterSizeB: 30, quantization: null };
  }

  if (kind === 'agent') {
    return {
      parameterSizeB: profile?.agentModelSize ?? profile?.modelSize ?? 0,
      quantization: profile?.quantization ?? null,
    };
  }
  return {
    parameterSizeB: profile?.modelSize ?? 0,
    quantization: profile?.quantization ?? null,
  };
}

export function poolOptsFromProfile(
  profile: CapabilityProfile | null | undefined,
  opts?: {
    role?: InferenceCtxRole;
    kind?: 'chat' | 'agent';
    /** Override size (tests / explicit). Default: from profile for role. */
    parameterSizeB?: number;
    quantization?: string | null;
  },
): PoolAwareCtxInput {
  const role = opts?.role ?? 'day';
  const specs = modelSpecsForCtxRole(profile, role, opts?.kind ?? 'chat');
  return {
    vramPoolGb: profile?.vramGb ?? 0,
    vramPoolKnown: profileVramPoolKnown(profile),
    parameterSizeB: opts?.parameterSizeB ?? specs.parameterSizeB,
    quantization: opts?.quantization !== undefined ? opts.quantization : specs.quantization,
    role,
  };
}

/**
 * Set Ollama num_ctx from capability pool + **the model that will run**.
 * When `ctxRole === 'heavy'`, uses heavyModelSize — not day/agent.
 * Caller must clear with setOllamaNumCtx(undefined) after the turn.
 */
export async function applyOllamaNumCtxForRole(
  kind: 'chat' | 'agent',
  ctxRole: InferenceCtxRole = 'day',
): Promise<number> {
  const profile = await getCapabilityProfile();
  const tier: Tier = kind === 'agent'
    ? (profile ? resolveAgentTier(profile) : 'standard')
    : (profile?.tier ?? 'standard');
  // Prefer heavy's own advertised context when escalating; else chat window.
  const contextWindow = profile?.contextWindow ?? 0;
  const pool = poolOptsFromProfile(profile, { role: ctxRole, kind });
  const numCtx = resolveInferenceNumCtx(contextWindow, tier, pool);
  logger.debug('llm', 'Ollama num_ctx (pool-aware)', {
    kind,
    ctxRole,
    numCtx,
    contextWindow,
    tier,
    vramPoolGb: pool.vramPoolGb,
    vramPoolKnown: pool.vramPoolKnown,
    parameterSizeB: pool.parameterSizeB,
    modelHint: ctxRole === 'heavy' ? profile?.heavyModelName : undefined,
  });
  setOllamaNumCtx(numCtx);
  return numCtx;
}
