import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const setOllamaNumCtx = vi.fn();
const getCapabilityProfile = vi.fn();

vi.mock('@/lib/ollama', () => ({
  setOllamaNumCtx,
}));

vi.mock('@/lib/capability-profile', () => ({
  getCapabilityProfile,
  resolveAgentTier: (profile: { agentTier?: string; tier?: string } | null) =>
    profile?.agentTier ?? profile?.tier ?? 'standard',
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('applyOllamaNumCtxForRole', () => {
  beforeEach(() => {
    setOllamaNumCtx.mockClear();
    getCapabilityProfile.mockReset();
  });

  it('sets num_ctx from pool-aware resolver and calls setOllamaNumCtx', async () => {
    getCapabilityProfile.mockResolvedValue({
      tier: 'plus',
      agentTier: 'plus',
      modelSize: 14,
      agentModelSize: 14,
      modelName: 'mock:14b',
      agentModelName: 'mock:14b',
      heavyModelName: 'big:70b',
      heavyModelSize: 70,
      heavyQuantization: 'Q4_K_M',
      quantization: 'Q4_K_M',
      vramGb: 16,
      vramSource: 'inference-override',
      contextWindow: 40000,
      gpuCount: 1,
      gpuName: 'test',
      isCpuOnly: false,
      detectedAt: Date.now(),
      source: 'live',
    });

    const { applyOllamaNumCtxForRole } = await import('@/lib/chat/inference-ctx');
    const { resolveInferenceNumCtx } = await import('@/lib/chat/context-budget');
    const dayCtx = await applyOllamaNumCtxForRole('agent', 'day');
    const heavyCtx = await applyOllamaNumCtxForRole('agent', 'heavy');
    // Same pool: larger weights ⇒ smaller ctx
    expect(heavyCtx).toBeLessThan(dayCtx);
    expect(setOllamaNumCtx).toHaveBeenCalled();
    // Sanity: heavy path matches explicit heavy size in resolver
    expect(heavyCtx).toBe(resolveInferenceNumCtx(40000, 'plus', {
      vramPoolGb: 16,
      vramPoolKnown: true,
      parameterSizeB: 70,
      quantization: 'Q4_K_M',
      role: 'heavy',
    }));
  });
});
