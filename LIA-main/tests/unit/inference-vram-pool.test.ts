import { describe, it, expect } from 'vitest';
import {
  isOllamaLoopback,
  parseInferenceVramGb,
  resolveVramPool,
} from '@/lib/capability-profile';

describe('isOllamaLoopback', () => {
  it('treats localhost / 127.0.0.1 / ::1 as local', () => {
    expect(isOllamaLoopback('http://127.0.0.1:11434')).toBe(true);
    expect(isOllamaLoopback('http://localhost:11434')).toBe(true);
    expect(isOllamaLoopback('http://[::1]:11434')).toBe(true);
  });

  it('treats LAN / remote hosts as non-local', () => {
    expect(isOllamaLoopback('http://192.168.1.50:11434')).toBe(false);
    expect(isOllamaLoopback('http://ollama.local:11434')).toBe(false);
    expect(isOllamaLoopback('https://gpu-box.lan:11434')).toBe(false);
  });

  it('malformed URL fails open to local', () => {
    expect(isOllamaLoopback('not-a-url')).toBe(true);
  });
});

describe('parseInferenceVramGb', () => {
  it('parses positive numbers', () => {
    expect(parseInferenceVramGb('12')).toBe(12);
    expect(parseInferenceVramGb('16.5')).toBe(16.5);
  });

  it('rejects empty / invalid', () => {
    expect(parseInferenceVramGb(undefined)).toBeNull();
    expect(parseInferenceVramGb('')).toBeNull();
    expect(parseInferenceVramGb('0')).toBeNull();
    expect(parseInferenceVramGb('-4')).toBeNull();
    expect(parseInferenceVramGb('abc')).toBeNull();
  });
});

describe('resolveVramPool', () => {
  const localGpu = { count: 1, vramGb: 8, name: 'Apple M2 (16 GB unified)' };

  it('loopback uses local GPU detection', () => {
    const pool = resolveVramPool({
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      localGpu,
    });
    expect(pool.vramSource).toBe('local-gpu');
    expect(pool.vramGb).toBe(8);
    expect(pool.isCpuOnly).toBe(false);
    expect(pool.vramPoolKnown).toBe(true);
  });

  it('loopback without GPU → cpu-only', () => {
    const pool = resolveVramPool({
      ollamaBaseUrl: 'http://localhost:11434',
      localGpu: null,
    });
    expect(pool.vramSource).toBe('cpu-only');
    expect(pool.isCpuOnly).toBe(true);
  });

  it('remote ignores UI GPU and uses LIA_INFERENCE_VRAM_GB', () => {
    const pool = resolveVramPool({
      ollamaBaseUrl: 'http://192.168.1.10:11434',
      inferenceVramGbEnv: '12',
      localGpu, // would wrongly demote if used
    });
    expect(pool.vramSource).toBe('inference-override');
    expect(pool.vramGb).toBe(12);
    expect(pool.gpuName).toContain('12');
    expect(pool.isCpuOnly).toBe(false);
    expect(pool.vramPoolKnown).toBe(true);
  });

  it('remote without override does not use UI Metal/nvidia-smi', () => {
    const pool = resolveVramPool({
      ollamaBaseUrl: 'http://192.168.1.10:11434',
      localGpu,
    });
    expect(pool.vramSource).toBe('inference-unknown');
    expect(pool.vramGb).toBe(0);
    expect(pool.vramPoolKnown).toBe(false);
    expect(pool.isCpuOnly).toBe(false);
    expect(pool.gpuName).toMatch(/LIA_INFERENCE_VRAM_GB/);
  });
});
