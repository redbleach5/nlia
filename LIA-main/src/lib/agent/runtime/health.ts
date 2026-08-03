// ============================================================================
// Runtime health probes — TCP + HTTP (pure enough for unit tests with injected fetch).
// ============================================================================

export type HttpProbeResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

const LISTING_BODY_SAMPLE = 12_000;

/**
 * Detect static-file directory listings (serve / classic "Index of").
 * Those return HTTP 200 but are not a valid artifact preview document.
 */
export function isDirectoryListingHtml(body: string): boolean {
  const sample = body.slice(0, LISTING_BODY_SAMPLE);
  if (/<title[^>]*>\s*Index of\b/i.test(sample)) return true;
  if (/\bIndex of\s+[/\\]/i.test(sample)) return true;
  if (/\bIndex of\s+\S+/i.test(sample) && /<a\s+href=/i.test(sample)) return true;
  // vercel/serve style file browser
  if (/<title[^>]*>\s*Files within\b/i.test(sample)) return true;
  if (/id=["']files["']/i.test(sample) && /Directory/i.test(sample)) return true;
  return false;
}

/**
 * Poll GET until 2xx/3xx with a real document, or timeout.
 * 404 = server up but missing entry file.
 * Directory listing = 200 but not a valid preview → not ok.
 */
export async function probeHttpUrl(
  url: string,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<HttpProbeResult> {
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  const pollMs = opts?.pollMs ?? 400;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';

  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(2000, Math.max(500, deadline - Date.now()))),
      });
      if (res.status >= 200 && res.status < 400) {
        const body = await res.text().catch(() => '');
        if (isDirectoryListingHtml(body)) {
          lastError =
            'directory listing — нет точки входа (write_file entry/index.html), Preview не должен показывать Index of';
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        return { ok: true, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
      // 404/5xx while server responds — keep polling briefly (serve may still be binding)
      if (res.status === 404) {
        lastError =
          'HTTP 404 — нет файла по preview URL (нужен write_file entry, обычно index.html в корне)';
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return { ok: false, error: lastError };
}
