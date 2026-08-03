import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/ollama', () => ({
  setOllamaNumCtx: vi.fn(),
}));

vi.mock('@/lib/capability-profile', () => ({
  getCapabilityProfile: vi.fn(),
  resolveAgentTier: (p: { agentTier?: string; tier?: string } | null) =>
    p?.agentTier ?? p?.tier ?? 'standard',
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('modelSpecsForCtxRole / poolOptsFromProfile (heavy size)', () => {
  it('heavy role uses heavyModelSize, not day size', async () => {
    const { modelSpecsForCtxRole, poolOptsFromProfile } = await import('@/lib/chat/inference-ctx');
    const profile = {
      tier: 'plus' as const,
      modelSize: 14,
      modelName: 'day:14b',
      agentModelSize: 14,
      agentModelName: 'day:14b',
      heavyModelName: 'big:70b',
      heavyModelSize: 70,
      heavyQuantization: 'Q4_K_M',
      quantization: 'Q4_K_M',
      vramGb: 16,
      vramSource: 'inference-override' as const,
      contextWindow: 40000,
      gpuCount: 1,
      gpuName: 'test',
      isCpuOnly: false,
      detectedAt: Date.now(),
      source: 'live' as const,
    };
    expect(modelSpecsForCtxRole(profile, 'day').parameterSizeB).toBe(14);
    expect(modelSpecsForCtxRole(profile, 'heavy').parameterSizeB).toBe(70);
    const dayPool = poolOptsFromProfile(profile, { role: 'day' });
    const heavyPool = poolOptsFromProfile(profile, { role: 'heavy' });
    expect(dayPool.parameterSizeB).toBe(14);
    expect(heavyPool.parameterSizeB).toBe(70);
    expect(heavyPool.role).toBe('heavy');
  });
});
