/**
 * Normalize user input for the Ollama HTTP endpoint.
 *
 * Accepts full URLs or a bare host / IP (LAN remote box):
 *   - http://192.168.1.50:11434
 *   - 192.168.1.50
 *   - 192.168.1.50:11434
 *   - lia-gpu.local
 *
 * Returns canonical origin (no path, no trailing slash), or null if invalid.
 * Bare http hosts get port 11434 when omitted.
 */
export function normalizeOllamaBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return null;

  let input = trimmed;
  if (!/^https?:\/\//i.test(input)) {
    input = `http://${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  // Default Ollama port for plain HTTP when the user typed only an IP/host.
  if (url.protocol === 'http:' && !url.port) {
    url.port = '11434';
  }

  return url.origin;
}

/** True when the URL points at this machine (loopback). */
export function isOllamaLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]';
  } catch {
    return true;
  }
}
