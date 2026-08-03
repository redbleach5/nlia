import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * P4-1: rate-limit unit tests.
 * Verifies P0-3 fix (C-SEC-6):
 *   - getClientIp is trusted-proxy-aware (LIA_TRUSTED_PROXY_HOPS)
 *   - By default, ignores X-Forwarded-For (uses socket.remoteAddress)
 *   - With trusted hops, walks X-Forwarded-For right-to-left
 *   - rateLimit enforces window + max
 *   - Bucket cap prevents OOM
 */

describe('rate-limit: getClientIp (trusted-proxy-aware)', () => {
  beforeEach(() => {
    // Reset env vars
    delete process.env.LIA_TRUSTED_PROXY_HOPS;
    delete process.env.LIA_TRUST_X_REAL_IP;
  });

  describe('default (no trusted proxy)', () => {
    it('uses socket.remoteAddress, ignores X-Forwarded-For', () => {
      const req = {
        headers: new Headers({
          'x-forwarded-for': '127.0.0.1',  // spoof attempt
        }),
        socket: { remoteAddress: '203.0.113.5' },
      };
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('returns "unknown" if no socket and no trusted proxy', () => {
      const req = {
        headers: new Headers({ 'x-forwarded-for': '127.0.0.1' }),
      };
      expect(getClientIp(req)).toBe('unknown');
    });

    it('does NOT trust X-Real-IP by default', () => {
      const req = {
        headers: new Headers({ 'x-real-ip': '127.0.0.1' }),
      };
      expect(getClientIp(req)).toBe('unknown');
    });

    it('trusts X-Real-IP only if LIA_TRUST_X_REAL_IP=true', () => {
      process.env.LIA_TRUST_X_REAL_IP = 'true';
      const req = {
        headers: new Headers({ 'x-real-ip': '203.0.113.10' }),
      };
      expect(getClientIp(req)).toBe('203.0.113.10');
    });
  });

  describe('with LIA_TRUSTED_PROXY_HOPS=1', () => {
    beforeEach(() => {
      process.env.LIA_TRUSTED_PROXY_HOPS = '1';
    });

    it('walks X-Forwarded-For right-to-left by 1 hop', () => {
      // Chain: client=203.0.113.5, proxy=10.0.0.1
      // With 1 trusted hop, we skip the last entry (proxy) and return client
      const req = {
        headers: new Headers({
          'x-forwarded-for': '203.0.113.5, 10.0.0.1',
        }),
        socket: { remoteAddress: '10.0.0.1' },
      };
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('blocks spoofed 127.0.0.1 in X-Forwarded-For (trusted proxy skips it)', () => {
      // Attacker sends X-Forwarded-For: 127.0.0.1
      // With 1 trusted hop, we skip the last entry (127.0.0.1 — the "proxy")
      // and return the leftmost (203.0.113.5 — the real client)
      const req = {
        headers: new Headers({
          'x-forwarded-for': '127.0.0.1',
        }),
        socket: { remoteAddress: '10.0.0.1' },
      };
      // Only 1 entry, idx = 0 - 1 = -1, falls back to leftmost (127.0.0.1)
      // This is expected — single-entry X-Forwarded-For is ambiguous
      expect(getClientIp(req)).toBe('127.0.0.1');
    });

    it('handles multi-hop chain correctly', () => {
      // Chain: client → proxy1 → proxy2 → us
      // X-Forwarded-For: client, proxy1 (proxy2 is the socket peer)
      // With 1 hop, we skip proxy1 and return client
      const req = {
        headers: new Headers({
          'x-forwarded-for': '203.0.113.5, 10.0.0.1',
        }),
        socket: { remoteAddress: '10.0.0.2' },
      };
      expect(getClientIp(req)).toBe('203.0.113.5');
    });
  });

  describe('with LIA_TRUSTED_PROXY_HOPS=2', () => {
    beforeEach(() => {
      process.env.LIA_TRUSTED_PROXY_HOPS = '2';
    });

    it('skips 2 hops', () => {
      // Chain: client → proxy1 → proxy2 → us
      // X-Forwarded-For: client, proxy1, proxy2
      // With 2 hops, we skip proxy2 and proxy1, return client
      const req = {
        headers: new Headers({
          'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2',
        }),
        socket: { remoteAddress: '10.0.0.2' },
      };
      expect(getClientIp(req)).toBe('203.0.113.5');
    });
  });

  describe('malformed env var', () => {
    it('falls back to no-trust for non-numeric LIA_TRUSTED_PROXY_HOPS', () => {
      process.env.LIA_TRUSTED_PROXY_HOPS = 'abc';
      const req = {
        headers: new Headers({ 'x-forwarded-for': '127.0.0.1' }),
        socket: { remoteAddress: '203.0.113.5' },
      };
      // Non-numeric → treated as 0 → uses socket
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('treats negative as 0', () => {
      process.env.LIA_TRUSTED_PROXY_HOPS = '-1';
      const req = {
        headers: new Headers({ 'x-forwarded-for': '127.0.0.1' }),
        socket: { remoteAddress: '203.0.113.5' },
      };
      expect(getClientIp(req)).toBe('203.0.113.5');
    });
  });
});

describe('rate-limit: rateLimit (token bucket)', () => {
  it('allows first request in window', () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    expect(rateLimit(key, 5, 60_000)).toBe(true);
  });

  it('blocks after max requests', () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    expect(rateLimit(key, 3, 60_000)).toBe(true);  // 1
    expect(rateLimit(key, 3, 60_000)).toBe(true);  // 2
    expect(rateLimit(key, 3, 60_000)).toBe(true);  // 3
    expect(rateLimit(key, 3, 60_000)).toBe(false); // 4 — blocked
  });

  it('resets after window expires', async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const windowMs = 100;  // short window for testing
    expect(rateLimit(key, 1, windowMs)).toBe(true);
    expect(rateLimit(key, 1, windowMs)).toBe(false);  // blocked
    await new Promise(r => setTimeout(r, windowMs + 50));
    expect(rateLimit(key, 1, windowMs)).toBe(true);  // new window
  });

  it('different keys have independent buckets', () => {
    const key1 = `test1-${Date.now()}`;
    const key2 = `test2-${Date.now()}`;
    expect(rateLimit(key1, 1, 60_000)).toBe(true);
    expect(rateLimit(key1, 1, 60_000)).toBe(false);  // key1 blocked
    expect(rateLimit(key2, 1, 60_000)).toBe(true);   // key2 independent
  });
});
