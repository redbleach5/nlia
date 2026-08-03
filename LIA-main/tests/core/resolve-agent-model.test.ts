import { describe, expect, it } from 'vitest';
import { resolveAgentModelName } from '@/lib/llm/resolve-agent-model';

describe('resolveAgentModelName', () => {
  it('falls back to chat model when agent model is empty', () => {
    expect(resolveAgentModelName('qwen2.5:7b', '')).toBe('qwen2.5:7b');
    expect(resolveAgentModelName('qwen2.5:7b', null)).toBe('qwen2.5:7b');
    expect(resolveAgentModelName('qwen2.5:7b', undefined)).toBe('qwen2.5:7b');
    expect(resolveAgentModelName('qwen2.5:7b', '   ')).toBe('qwen2.5:7b');
  });

  it('uses configured agent model when set', () => {
    expect(resolveAgentModelName('qwen2.5:7b', 'qwen3:8b')).toBe('qwen3:8b');
  });

  it('trims whitespace on agent model', () => {
    expect(resolveAgentModelName('chat', '  qwen3:8b  ')).toBe('qwen3:8b');
  });
});
