import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAgentCognitiveParamsMock = vi.fn();

vi.mock('@/lib/capability-profile', () => ({
  getAgentCognitiveParams: () => getAgentCognitiveParamsMock(),
}));

describe('resolveAgentPhaseMaxTokens', () => {
  beforeEach(() => {
    vi.resetModules();
    getAgentCognitiveParamsMock.mockReset();
  });

  it('planning stays at compact floor', async () => {
    getAgentCognitiveParamsMock.mockResolvedValue({
      params: { maxTokens: 16384 },
      profile: { tier: 'standard', agentTier: 'max' },
      agentTier: 'max',
    });
    const { resolveAgentPhaseMaxTokens, PLANNING_MAX_TOKENS } = await import(
      '@/lib/agent/runner-helpers'
    );
    expect(await resolveAgentPhaseMaxTokens('planning')).toBe(PLANNING_MAX_TOKENS);
  });

  it('execution/synthesis follow agent-tier maxTokens on plus/max', async () => {
    getAgentCognitiveParamsMock.mockResolvedValue({
      params: { maxTokens: 8192 },
      profile: { tier: 'standard', agentTier: 'plus' },
      agentTier: 'plus',
    });
    const { resolveAgentPhaseMaxTokens } = await import('@/lib/agent/runner-helpers');
    expect(await resolveAgentPhaseMaxTokens('execution')).toBe(8192);
    expect(await resolveAgentPhaseMaxTokens('synthesis')).toBe(8192);
  });

  it('micro may return below legacy execution floor', async () => {
    getAgentCognitiveParamsMock.mockResolvedValue({
      params: { maxTokens: 2048 },
      profile: { tier: 'micro', agentTier: 'micro' },
      agentTier: 'micro',
    });
    const { resolveAgentPhaseMaxTokens } = await import('@/lib/agent/runner-helpers');
    expect(await resolveAgentPhaseMaxTokens('execution')).toBe(2048);
  });
});
