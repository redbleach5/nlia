import { describe, it, expect } from 'vitest';
import {
  normalizeCapabilityProfile,
  resolveAgentTier,
  getTierParams,
  type CapabilityProfile,
} from '@/lib/capability-profile';
import { classifyTierFromBudget } from '@/lib/compute-budget';

function baseProfile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    tier: 'standard',
    modelSize: 8,
    modelName: 'dolphin3',
    quantization: 'Q4_K_M',
    vramGb: 16,
    gpuCount: 1,
    gpuName: 'RTX 4060 Ti',
    isCpuOnly: false,
    contextWindow: 32768,
    detectedAt: Date.now(),
    source: 'live',
    ...overrides,
  };
}

describe('dual-tier: chat vs agent', () => {
  it('8B chat + 14B agent → standard chat, plus agent (same VRAM floors)', () => {
    const base = {
      vramPoolGb: 16,
      gpuCount: 1,
      isCpuOnly: false,
      vramPoolKnown: true,
      pressure: 'comfortable' as const,
    };
    expect(classifyTierFromBudget({ ...base, modelSizeB: 8 })).toBe('standard');
    expect(classifyTierFromBudget({ ...base, modelSizeB: 14 })).toBe('plus');
  });

  it('resolveAgentTier prefers agentTier over chat tier', () => {
    expect(resolveAgentTier(baseProfile({
      tier: 'standard',
      agentTier: 'plus',
    }))).toBe('plus');
  });

  it('resolveAgentTier falls back to chat tier on legacy profiles', () => {
    expect(resolveAgentTier(baseProfile({ tier: 'standard' }))).toBe('standard');
  });

  it('normalizeCapabilityProfile fills missing agent fields from chat', () => {
    const normalized = normalizeCapabilityProfile(baseProfile());
    expect(normalized.agentTier).toBe('standard');
    expect(normalized.agentModelSize).toBe(8);
    expect(normalized.agentModelName).toBe('dolphin3');
  });

  it('agent plus budgets are not capped by chat standard', () => {
    const chatParams = getTierParams('standard');
    const agentParams = getTierParams('plus');
    expect(agentParams.agentMaxSteps).toBeGreaterThan(chatParams.agentMaxSteps);
    expect(agentParams.maxTokens).toBeGreaterThan(chatParams.maxTokens);
    expect(agentParams.agentMaxDurationSec).toBeGreaterThan(chatParams.agentMaxDurationSec);
  });
});
