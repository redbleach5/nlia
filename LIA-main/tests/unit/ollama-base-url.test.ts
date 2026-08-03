import { describe, expect, it } from 'vitest';
import { isOllamaLoopbackUrl, normalizeOllamaBaseUrl } from '@/lib/ollama-base-url';

describe('normalizeOllamaBaseUrl', () => {
  it('keeps a full local URL', () => {
    expect(normalizeOllamaBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });

  it('adds http and default port for bare IP', () => {
    expect(normalizeOllamaBaseUrl('192.168.1.50')).toBe('http://192.168.1.50:11434');
  });

  it('adds http for IP:port', () => {
    expect(normalizeOllamaBaseUrl('192.168.1.50:11434')).toBe('http://192.168.1.50:11434');
  });

  it('keeps custom http port', () => {
    expect(normalizeOllamaBaseUrl('http://10.0.0.2:12345')).toBe('http://10.0.0.2:12345');
  });

  it('strips path to origin', () => {
    expect(normalizeOllamaBaseUrl('http://192.168.1.50:11434/v1')).toBe('http://192.168.1.50:11434');
  });

  it('rejects blank and whitespace hosts', () => {
    expect(normalizeOllamaBaseUrl('')).toBeNull();
    expect(normalizeOllamaBaseUrl('  ')).toBeNull();
    expect(normalizeOllamaBaseUrl('192.168.1.50 extra')).toBeNull();
  });
});

describe('isOllamaLoopbackUrl', () => {
  it('detects loopback', () => {
    expect(isOllamaLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isOllamaLoopbackUrl('http://localhost:11434')).toBe(true);
  });

  it('detects remote LAN', () => {
    expect(isOllamaLoopbackUrl('http://192.168.1.50:11434')).toBe(false);
  });
});
