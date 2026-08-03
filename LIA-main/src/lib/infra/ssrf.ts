import 'server-only';

// ============================================================================
// SSRF protection — проверка URL/IP перед fetch.
// ============================================================================
//
// Используется:
//   - lib/agent/tools.ts — http_request tool (agent mode)
//   - lib/tools/web-search.ts — fetchPage (web_search + fetch_page tools)
//
// Защита от:
//   - Прямых запросов к private IP (127.x, 10.x, 192.168.x, 172.16-31.x, link-local)
//   - IPv6 loopback/ULA/link-local
//   - IPv4-mapped IPv6 (::ffff:1.2.3.4) — рекурсивная проверка inner IP
//   - localhost hostname
//   - CGNAT (100.64.0.0/10) и 0.0.0.0/8
//   - AWS metadata endpoint (169.254.169.254) — покрывается link-local
//
// Ограничения:
//   - TOCTOU race: DNS resolved at check time, fetch re-resolves at connect time.
//     Для local-first приложения на localhost — приемлемый риск.
//     Для production нужна пиннгация IP в fetch через lookup callback.
//   - DNS rebinding с TTL=0: теоретически возможен, но требует контроля DNS-сервера жертвы.

import { lookup } from 'dns/promises';
import { isIP } from 'net';

const BLOCKED_IP_PATTERNS = [
  /^127\./,                           // loopback
  /^10\./,                            // private class A
  /^192\.168\./,                      // private class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // private class B
  /^169\.254\./,                      // link-local (включая AWS metadata 169.254.169.254)
  /^0\./,                             // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^100\.100\.100\./,                 // Alibaba Cloud metadata 100.100.100.200
  /^::1$/,                            // IPv6 loopback
  // P1-2 fix (H-SEC-4): correct IPv6 ULA fc00::/7 (covers fc00:: - fdff::)
  /^f[cd][0-9a-f]{2}:/i,              // IPv6 ULA fc00::/7
  // P1-2 fix (H-SEC-4): correct IPv6 link-local fe80::/10 (covers fe80:: - febf::)
  /^fe[89ab][0-9a-f]:/i,              // IPv6 link-local fe80::/10 (P4-fix: was [0-9a-f]{2})
  /^::ffff:/,                         // IPv4-mapped IPv6 (check inner)
];

export function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6 in both short and long forms:
  //   Short:  ::ffff:1.2.3.4
  //   Long:   0:0:0:0:0:ffff:0102:0304
  // P1-2 fix (H-SEC-4): previous regex only matched short form — long form
  // bypassed the inner-IP check.
  const shortMapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (shortMapped) {
    return isPrivateIp(shortMapped[1]);
  }
  const longMapped = ip.match(/^(?:0:){5}ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (longMapped) {
    const inner = `${longMapped[1]}.${longMapped[2]}.${longMapped[3]}.${longMapped[4]}`;
    return isPrivateIp(inner);
  }
  // Also handle hex form: 0:0:0:0:0:ffff:0102:0304
  const hexMapped = ip.match(/^(?:0:){5}ffff:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hexMapped) {
    const a = parseInt(hexMapped[1], 16);
    const b = parseInt(hexMapped[2], 16);
    const c = parseInt(hexMapped[3], 16);
    const d = parseInt(hexMapped[4], 16);
    const inner = `${a}.${b}.${c}.${d}`;
    return isPrivateIp(inner);
  }
  return BLOCKED_IP_PATTERNS.some(re => re.test(ip));
}

/**
 * Resolve hostname and check ALL resolved IPs against blocklist.
 * Throws if any IP is private/blocked.
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  // If hostname is already an IP, check directly
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`blocked IP: ${hostname}`);
    }
    return;
  }

  // localhost check
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('blocked: localhost');
  }

  // DNS resolve
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new Error(`no DNS records for ${hostname}`);
  }

  // Check ALL resolved IPs
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`blocked IP ${address} for ${hostname}`);
    }
  }
}

/**
 * Проверить URL на SSRF-безопасность.
 * Бросает Error, если hostname резолвится в private/blocked IP
 * или если используется не-http(s) протокол.
 *
 * Используйте перед fetch() для любых URL, пришедших от LLM или пользователя.
 */
export async function assertSafeUrl(url: string): Promise<URL> {
  const u = new URL(url);
  // Разрешаем только http/https — никакого file://, ftp://, gopher:// и т.п.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked protocol: ${u.protocol}`);
  }
  assertAllowedPort(u);
  await assertSafeHost(u.hostname);
  return u;
}

/** Default allowlist: 80/443 (+ optional extras). Empty port = scheme default. */
const DEFAULT_ALLOWED_PORTS = new Set([80, 443]);

export function assertAllowedPort(
  u: URL,
  allowedPorts: ReadonlySet<number> = DEFAULT_ALLOWED_PORTS,
): void {
  let port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port)) {
    throw new Error(`blocked port: invalid`);
  }
  if (!allowedPorts.has(port)) {
    throw new Error(`blocked port: ${port} (allowed: ${[...allowedPorts].join(', ')})`);
  }
}

/** Methods allowed for agent/network fetch by default. */
const DEFAULT_ALLOWED_METHODS = new Set(['GET', 'HEAD']);

export function assertAllowedMethod(
  method: string,
  allowed: ReadonlySet<string> = DEFAULT_ALLOWED_METHODS,
): void {
  const m = method.toUpperCase();
  if (!allowed.has(m)) {
    throw new Error(`blocked method: ${m} (allowed: ${[...allowed].join(', ')})`);
  }
}
