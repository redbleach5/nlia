/**
 * SSRF protection — prevent Server-Side Request Forgery in web tools.
 *
 * Per docs/ARCHITECTURE.md § Appendix A: "port".
 * Blocks requests to private/internal IP ranges + localhost.
 * Follows redirects manually and re-validates each hop.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_RANGES = [
  /^127\./, // loopback
  /^10\./, // private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // private
  /^192\.168\./, // private
  /^169\.254\./, // link-local
  /^0\./, // reserved
  /^::1$/, // IPv6 loopback
  /^fc00:/, // IPv6 unique local
  /^fe80:/, // IPv6 link-local
];

const MAX_REDIRECTS = 5;

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * Check if a URL is safe to fetch (no SSRF).
 * Resolves hostname and checks against blocked ranges.
 */
export async function checkSsrf(url: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `protocol ${parsed.protocol} not allowed` };
  }

  const hostname = parsed.hostname;

  // Check if IP literal
  const ipType = isIP(hostname);
  if (ipType > 0) {
    if (BLOCKED_RANGES.some((re) => re.test(hostname))) {
      return { allowed: false, reason: `IP ${hostname} is in blocked range` };
    }
    return { allowed: true, resolvedIp: hostname };
  }

  // Resolve hostname
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (BLOCKED_RANGES.some((re) => re.test(addr.address))) {
        return { allowed: false, reason: `hostname ${hostname} resolves to blocked IP ${addr.address}` };
      }
    }
    return { allowed: true, resolvedIp: addresses[0]?.address };
  } catch {
    return { allowed: false, reason: `failed to resolve hostname ${hostname}` };
  }
}

/**
 * Safe fetch — checks SSRF before fetching and on every redirect hop.
 * Throws if the URL (or a redirect target) is blocked.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  let currentUrl = url;
  const { redirect: _ignored, ...rest } = init ?? {};

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkSsrf(currentUrl);
    if (!check.allowed) {
      throw new Error(`SSRF blocked: ${check.reason}`);
    }

    const res = await fetch(currentUrl, { ...rest, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`SSRF blocked: redirect ${res.status} without Location`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new Error(`SSRF blocked: too many redirects (max ${MAX_REDIRECTS})`);
}
