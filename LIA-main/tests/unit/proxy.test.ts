import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

function request(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, { headers });
}

describe('API proxy network boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows the localhost browser without a token', () => {
    const response = proxy(request('http://localhost/api/episodes'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('denies a remote destination by default, including development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = proxy(request('http://192.168.1.20/api/episodes'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('remote access is disabled'),
    });
  });

  it('requires a configured token when remote access is enabled', async () => {
    vi.stubEnv('LIA_ALLOW_REMOTE', 'true');
    const response = proxy(request('http://192.168.1.20/api/episodes'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('LIA_INTERNAL_TOKEN'),
    });
  });

  it('rejects an invalid remote token', () => {
    vi.stubEnv('LIA_ALLOW_REMOTE', 'true');
    vi.stubEnv('LIA_INTERNAL_TOKEN', 'correct-secret');
    const response = proxy(request('http://192.168.1.20/api/episodes', {
      'x-lia-internal': 'wrong-secret',
    }));
    expect(response.status).toBe(403);
  });

  it('allows an explicitly enabled remote API client with the token', () => {
    vi.stubEnv('LIA_ALLOW_REMOTE', 'true');
    vi.stubEnv('LIA_INTERNAL_TOKEN', 'correct-secret');
    const response = proxy(request('http://192.168.1.20/api/episodes', {
      'x-lia-internal': 'correct-secret',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
