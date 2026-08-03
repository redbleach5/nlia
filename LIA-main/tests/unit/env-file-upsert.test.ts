import { describe, it, expect } from 'vitest';
import { removeEnvVar, upsertEnvVar } from '@/lib/infra/env-file-upsert';

describe('env-file-upsert', () => {
  it('upsert replaces existing key', () => {
    const input = '# Ollama\nOLLAMA_MODEL=qwen2.5:7b\n';
    const out = upsertEnvVar(input, 'OLLAMA_MODEL', 'qwen3:8b');
    expect(out).toContain('OLLAMA_MODEL=qwen3:8b');
    expect(out).not.toContain('qwen2.5:7b');
  });

  it('upsert appends missing key', () => {
    const out = upsertEnvVar('FOO=1\n', 'OLLAMA_MODEL', 'qwen3:8b');
    expect(out.trimEnd().endsWith('OLLAMA_MODEL=qwen3:8b')).toBe(true);
  });

  it('remove drops key line', () => {
    const input = 'OLLAMA_AGENT_MODEL=qwen3:8b\nOLLAMA_MODEL=x\n';
    const out = removeEnvVar(input, 'OLLAMA_AGENT_MODEL');
    expect(out).not.toContain('OLLAMA_AGENT_MODEL');
    expect(out).toContain('OLLAMA_MODEL=x');
  });
});
