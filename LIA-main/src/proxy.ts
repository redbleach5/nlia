// Proxy (Next.js 16 — replacement for deprecated middleware) —
// thin auth + rate-limit for API routes.
//
// Default threat model: local-first localhost (owner + family on one machine).
// These checks matter if the port is exposed on LAN or behind a reverse proxy —
// not a multi-user product layer. Leave defaults alone for home use.
//
// Security fixes:
//   - P0-3 (C-SEC-6): getClientIp trusted-proxy-aware (LIA_TRUSTED_PROXY_HOPS, default 0).
//   - P0-3 (C-SEC-7): auth выполняется ДО short-circuit для upload-vrm.
//   - P0-3 (H-SEC-7): constant-time comparison для LIA_INTERNAL_TOKEN.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual, createHash } from 'crypto';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * P-CORE-25 fix: constant-time comparison that doesn't leak token length.
 *
 * Previously the early `bufA.length !== bufB.length` check returned in O(1),
 * leaking the token length to a timing attacker. The `timingSafeEqual(bufA, bufA)`
 * self-compare mitigation took time proportional to `bufA.length` (the
 * attacker-supplied value), not `bufB.length` (the secret) — so it didn't
 * actually hide the length-mismatch branch.
 *
 * Now we SHA-256 both inputs (always 32 bytes) and compare the hashes with
 * `timingSafeEqual`. Runtime is independent of either input's length, and
 * the hash is deterministic so equality is preserved.
 */
function safeTokenEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function proxy(req: NextRequest) {
  const ip = getClientIp(req);
  const path = req.nextUrl.pathname;
  const isDev = process.env.NODE_ENV !== 'production';
  const hostname = req.nextUrl.hostname.toLowerCase();
  const isLoopbackHost = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
  const isLoopbackIp = ip === '127.0.0.1' || ip === '::1';
  // NextRequest does not expose socket.remoteAddress in every runtime. A
  // loopback destination is a safe fallback only while scripts bind the
  // server to 127.0.0.1 (see package.json).
  const isLocalRequest = isLoopbackIp || (ip === 'unknown' && isLoopbackHost);
  const allowRemote = process.env.LIA_ALLOW_REMOTE === 'true';

  if (req.method === 'POST' || req.method === 'GET') {
    let max = 60;
    let window = 60_000;

    if (req.method === 'POST') {
      if (path.startsWith('/api/chat')) max = 20;
      else if (path.startsWith('/api/chat/attachments')) max = 15;
      else if (path.startsWith('/api/agent')) max = 5;
      else if (path.startsWith('/api/settings/upload-vrm')) max = 3;
      else if (path.startsWith('/api/kb/sources/upload')) max = 3;
      else if (path === '/api/kb/sources') max = 10;
    } else {
      // Expensive/read-long-lived endpoints need their own request budget.
      if (/^\/api\/agent\/[^/]+\/stream$/.test(path)) max = 10;
      else if (path === '/api/kb/search') max = 30;
      else if (path === '/api/health') max = 120;
      else return enforceRemoteBoundary(req, isLocalRequest, allowRemote) ?? NextResponse.next();
    }

    if (isDev) max *= 3;

    const ok = rateLimit(`${path}:${ip}`, max, window);
    if (!ok) {
      return NextResponse.json(
        { error: 'rate limit exceeded, try again later' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(window / 1000)) } },
      );
    }
  }

  const boundaryResponse = enforceRemoteBoundary(req, isLocalRequest, allowRemote);
  if (boundaryResponse) return boundaryResponse;

  if (path === '/api/settings/upload-vrm' || path === '/api/kb/sources/upload') {
    return NextResponse.next();
  }

  return NextResponse.next();
}

function enforceRemoteBoundary(
  req: NextRequest,
  isLocalRequest: boolean,
  allowRemote: boolean,
): NextResponse | null {
  if (isLocalRequest) return null;
  if (!allowRemote) {
    return NextResponse.json(
      { error: 'remote access is disabled; use localhost or set LIA_ALLOW_REMOTE=true' },
      { status: 403 },
    );
  }

  const internalToken = process.env.LIA_INTERNAL_TOKEN;
  if (!internalToken) {
    return NextResponse.json(
      { error: 'remote access requires LIA_INTERNAL_TOKEN' },
      { status: 503 },
    );
  }
  const header = req.headers.get('x-lia-internal') ?? '';
  if (!safeTokenEqual(header, internalToken)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

export const config = {
  matcher: '/api/:path*',
};
