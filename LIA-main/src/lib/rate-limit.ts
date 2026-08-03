// Rate limiting — простой in-memory token bucket.
// Local-first: mainly protects if :3000 is reachable beyond loopback.
// Not a multi-user product layer — leave defaults for home dual-use.
//
// P0-3 fix (C-SEC-6): getClientIp теперь trusted-proxy-aware.
// Спуфинг X-Forwarded-For: 127.0.0.1 больше не bypass'ит auth.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 100_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      let evicted = false;
      for (const [k, b] of buckets) {
        if (b.resetAt < now) { buckets.delete(k); evicted = true; break; }
      }
      if (!evicted) return false;
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

/**
 * P0-3 fix (C-SEC-6): Get client IP — trusted-proxy aware.
 *
 * - If LIA_TRUSTED_PROXY_HOPS=N is set, walk X-Forwarded-For right-to-left,
 *   skipping N hops, return (N+1)-th from right.
 * - If unset or 0, ignore X-Forwarded-For entirely, use socket.remoteAddress.
 */
export function getClientIp(req: Request | { headers: Headers; socket?: { remoteAddress?: string | null } }): string {
  const trustedHopsRaw = process.env.LIA_TRUSTED_PROXY_HOPS;
  const trustedHops = trustedHopsRaw ? Math.max(0, parseInt(trustedHopsRaw, 10) || 0) : 0;

  const socket = (req as { socket?: { remoteAddress?: string | null } }).socket;
  const socketAddr = typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : '';

  if (trustedHops > 0) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
      const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
      const idx = parts.length - 1 - trustedHops;
      if (idx >= 0) return parts[idx];
      if (parts.length > 0) return parts[0];
    }
    return socketAddr || 'unknown';
  }

  if (socketAddr) return socketAddr;
  if (process.env.LIA_TRUST_X_REAL_IP === 'true') {
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp;
  }
  return 'unknown';
}
