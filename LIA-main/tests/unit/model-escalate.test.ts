import { describe, it, expect } from 'vitest';
import { decideModelEscalate } from '@/lib/llm/model-escalate';
import {
  resolveModelForRole,
  configuredHeavyModelName,
} from '@/lib/llm/resolve-model-for-role';

describe('decideModelEscalate', () => {
  it('no-ops when heavy unset', () => {
    expect(decideModelEscalate({
      complexity: 'research',
      mode: 'agent',
      phase: 'plan',
      heavyConfigured: false,
    })).toEqual({ role: 'day', reason: 'heavy-unset' });
  });

  it('escalates plan on research/complex', () => {
    expect(decideModelEscalate({
      complexity: 'research',
      mode: 'agent',
      phase: 'plan',
      heavyConfigured: true,
    }).role).toBe('heavy');
    expect(decideModelEscalate({
      complexity: 'complex',
      mode: 'chat',
      phase: 'main',
      heavyConfigured: true,
    }).role).toBe('heavy');
  });

  it('keeps synthesize on day voice', () => {
    expect(decideModelEscalate({
      complexity: 'research',
      mode: 'agent',
      phase: 'synthesize',
      heavyConfigured: true,
      signals: { forceHeavy: true },
    })).toEqual({ role: 'day', reason: 'synthesize-day-voice' });
  });

  it('execute stays agent until loop threshold', () => {
    expect(decideModelEscalate({
      complexity: 'research',
      mode: 'agent',
      phase: 'execute',
      heavyConfigured: true,
      signals: { loopCount: 1 },
    }).role).toBe('day');
    expect(decideModelEscalate({
      complexity: 'research',
      mode: 'agent',
      phase: 'execute',
      heavyConfigured: true,
      signals: { loopCount: 2 },
    }).role).toBe('heavy');
  });
});

describe('resolveModelForRole', () => {
  const snap = {
    chat: 'chat-model',
    agentConfigured: 'agent-model',
    secondary: 'sec-model',
    heavy: null as string | null,
  };

  it('falls back heavy to agent when empty', () => {
    expect(resolveModelForRole('heavy', snap)).toBe('agent-model');
    expect(configuredHeavyModelName(snap)).toBeNull();
  });

  it('uses configured heavy when set', () => {
    expect(resolveModelForRole('heavy', { ...snap, heavy: 'big-model' })).toBe('big-model');
    expect(configuredHeavyModelName({ ...snap, heavy: 'big-model' })).toBe('big-model');
  });

  it('agent falls back to chat when unset', () => {
    expect(resolveModelForRole('agent', { ...snap, agentConfigured: '' })).toBe('chat-model');
  });
});
