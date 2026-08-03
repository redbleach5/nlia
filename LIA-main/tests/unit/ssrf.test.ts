import { describe, it, expect } from 'vitest';
import { isPrivateIp, assertAllowedPort, assertAllowedMethod } from '@/lib/infra/ssrf';

/**
 * P4-1: SSRF unit tests — covers IPv4, IPv6, IPv4-mapped IPv6 edge cases.
 * Verifies P0/P1/P2 fixes for:
 *   - IPv6 ULA fc00::/7 (was /^fc00::/ — missed fd00::)
 *   - IPv6 link-local fe80::/10 (was /^fe80::/ — missed fea0::)
 *   - IPv4-mapped IPv6 long form (was only short form ::ffff:1.2.3.4)
 *   - Alibaba metadata 100.100.100.200 (was missing)
 */
describe('SSRF: isPrivateIp', () => {
  describe('IPv4 private ranges', () => {
    it('blocks loopback 127.x.x.x', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('127.255.255.255')).toBe(true);
    });

    it('blocks private 10.x.x.x', () => {
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('10.255.255.255')).toBe(true);
    });

    it('blocks private 192.168.x.x', () => {
      expect(isPrivateIp('192.168.0.1')).toBe(true);
      expect(isPrivateIp('192.168.1.100')).toBe(true);
    });

    it('blocks private 172.16-31.x.x', () => {
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('172.31.255.255')).toBe(true);
      // 172.15 and 172.32 are public
      expect(isPrivateIp('172.15.0.1')).toBe(false);
      expect(isPrivateIp('172.32.0.1')).toBe(false);
    });

    it('blocks link-local 169.254.x.x (AWS metadata)', () => {
      expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS metadata
      expect(isPrivateIp('169.254.0.1')).toBe(true);
    });

    it('blocks 0.0.0.0/8', () => {
      expect(isPrivateIp('0.0.0.0')).toBe(true);
      expect(isPrivateIp('0.0.0.1')).toBe(true);
      expect(isPrivateIp('0.255.255.255')).toBe(true);
    });

    it('blocks CGNAT 100.64.0.0/10', () => {
      expect(isPrivateIp('100.64.0.1')).toBe(true);
      expect(isPrivateIp('100.127.255.255')).toBe(true);
      // 100.63 and 100.128 are public
      expect(isPrivateIp('100.63.0.1')).toBe(false);
      expect(isPrivateIp('100.128.0.1')).toBe(false);
    });

    it('blocks Alibaba metadata 100.100.100.x (P1-2 fix)', () => {
      expect(isPrivateIp('100.100.100.200')).toBe(true);
      expect(isPrivateIp('100.100.100.1')).toBe(true);
    });

    it('allows public IPs', () => {
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('93.184.216.34')).toBe(false); // example.com
    });
  });

  describe('IPv6', () => {
    it('blocks loopback ::1', () => {
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('blocks IPv6 ULA fc00::/7 (P1-2 fix — was /^fc00::/ only)', () => {
      // fc00:: — was caught by old regex
      expect(isPrivateIp('fc00::1')).toBe(true);
      // fd00:: — was MISSED by old /^fc00::/ regex
      expect(isPrivateIp('fd00::1')).toBe(true);
      expect(isPrivateIp('fd12:3456:789a::1')).toBe(true);
      expect(isPrivateIp('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
      // fe00:: is NOT ULA (below fc00::/7)
      expect(isPrivateIp('fe00::1')).toBe(false);
    });

    it('blocks IPv6 link-local fe80::/10 (P1-2 fix — was /^fe80::/ only)', () => {
      // fe80:: — was caught by old regex
      expect(isPrivateIp('fe80::1')).toBe(true);
      // fea0:: — was MISSED by old /^fe80::/ regex (fe80::/10 covers fe80-febf)
      expect(isPrivateIp('fea0::1')).toBe(true);
      expect(isPrivateIp('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
      // fe7f:: is NOT link-local (below fe80::/10)
      expect(isPrivateIp('fe7f::1')).toBe(false);
      // fec0:: is NOT link-local (above febf)
      expect(isPrivateIp('fec0::1')).toBe(false);
    });

    it('allows public IPv6', () => {
      expect(isPrivateIp('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
      expect(isPrivateIp('2001:4860:4860::8888')).toBe(false); // Google DNS
    });
  });

  describe('IPv4-mapped IPv6 (P1-2 fix)', () => {
    it('blocks short form ::ffff:1.2.3.4', () => {
      expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
    });

    it('blocks long form 0:0:0:0:0:ffff:1.2.3.4 (P1-2 fix — was missed)', () => {
      expect(isPrivateIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIp('0:0:0:0:0:ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIp('0:0:0:0:0:ffff:169.254.169.254')).toBe(true);
    });

    it('blocks hex form 0:0:0:0:0:ffff:0102:0304 (P1-2 fix — was missed)', () => {
      // 7f00:0001 = 127.0.0.1
      expect(isPrivateIp('0:0:0:0:0:ffff:7f00:0001')).toBe(true);
      // 0a00:0001 = 10.0.0.1
      expect(isPrivateIp('0:0:0:0:0:ffff:0a00:0001')).toBe(true);
    });

    it('allows IPv4-mapped public IPs', () => {
      expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
      expect(isPrivateIp('0:0:0:0:0:ffff:0808:0808')).toBe(false);
    });
  });
});

describe('SSRF: port / method limits (P4)', () => {
  it('allows 80/443 and blocks odd ports', () => {
    expect(() => assertAllowedPort(new URL('https://example.com/'))).not.toThrow();
    expect(() => assertAllowedPort(new URL('http://example.com:8080/'))).toThrow(/blocked port/);
    expect(() => assertAllowedPort(new URL('http://example.com:22/'))).toThrow(/blocked port/);
  });

  it('allows GET/HEAD only by default', () => {
    expect(() => assertAllowedMethod('GET')).not.toThrow();
    expect(() => assertAllowedMethod('HEAD')).not.toThrow();
    expect(() => assertAllowedMethod('POST')).toThrow(/blocked method/);
  });
});
