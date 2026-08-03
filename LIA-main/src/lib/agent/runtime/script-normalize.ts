// ============================================================================
// Normalize weak-model runtime scripts to allowlisted, launchable forms.
// Pure — safe for unit tests (no server-only).
// ============================================================================

const DEFAULT_PORT = 5173;

/** Bare CLIs models invent that are not in RUN_COMMAND_ALLOWED. */
const BARE_TO_NPX: Record<string, string> = {
  vite: 'vite',
  serve: 'serve',
  'http-server': 'serve',
  http_server: 'serve',
  'live-server': 'serve',
  liveserver: 'serve',
};

/**
 * Rewrite common invalid / incomplete scripts into allowlisted commands.
 * Examples:
 *   "vite"              → "npx --yes vite --host 127.0.0.1 --port 5173"
 *   "npx vite"          → "npx --yes vite --host 127.0.0.1 --port 5173"
 *   "http-server -p 5173" → "npx --yes serve -l 5173"
 */
export function normalizeRuntimeScript(
  script: string,
  port = DEFAULT_PORT,
): string {
  let s = script.trim().replace(/\s+/g, ' ');
  if (!s) return s;

  // Bare binary → npx package
  const first = s.split(/\s+/)[0] ?? '';
  if (BARE_TO_NPX[first]) {
    const pkg = BARE_TO_NPX[first];
    const rest = s.slice(first.length).trim();
    if (pkg === 'vite') {
      s = `npx --yes vite ${rest}`.trim();
    } else {
      s = `npx --yes serve ${rest || `-l ${port}`}`.trim();
    }
  }

  // http-server via npx → serve (same job, known-good flags)
  if (/^npx(\s+--yes)?\s+http-server\b/i.test(s)) {
    const m = s.match(/-p\s+(\d+)/i) || s.match(/--port\s+(\d+)/i);
    const p = m?.[1] ?? String(port);
    const root = s.match(/\s(\.\/?|src)\s*$/i)?.[1] ?? '';
    s = `npx --yes serve -l ${p}${root ? ` ${root}` : ''}`.trim();
  }

  // Ensure npx vite has --yes and binds localhost + port for health probe
  if (/^npx(\s+--yes)?\s+vite\b/i.test(s)) {
    if (!/\s--yes\b/i.test(s)) s = s.replace(/^npx\b/i, 'npx --yes');
    if (!/--host\b/i.test(s)) s += ' --host 127.0.0.1';
    if (!/--port\b/i.test(s) && !/\s-p\s+\d+/i.test(s)) s += ` --port ${port}`;
  }

  // Ensure npx serve has -l port
  if (/^npx(\s+--yes)?\s+serve\b/i.test(s)) {
    if (!/\s--yes\b/i.test(s)) s = s.replace(/^npx\b/i, 'npx --yes');
    if (!/\s-l\s+\d+/i.test(s) && !/--listen\b/i.test(s)) s += ` -l ${port}`;
  }

  // Soft-remap reserved Lia port inside script
  if (/\b3000\b/.test(s) && port !== 3000) {
    s = s.replace(/\b3000\b/g, String(port));
  }

  return s.replace(/\s+/g, ' ').trim();
}

/** Static HTML game/site without a Node project — prefer serve, not vite. */
export function isStaticWebDesign(input: {
  kind?: string;
  stack?: string[];
  treePaths?: string[];
  preset?: string;
}): boolean {
  const preset = (input.preset ?? '').toLowerCase();
  if (preset && preset !== 'static-game' && preset !== 'static-web') {
    return false;
  }
  const kind = (input.kind ?? '').toLowerCase();
  if (kind !== 'web' && kind !== 'game') return false;
  const paths = (input.treePaths ?? []).map((p) => p.replace(/\\/g, '/').toLowerCase());
  if (paths.some((p) => /(^|\/)package\.json$/.test(p))) return false;
  const stack = (input.stack ?? []).map((s) => s.toLowerCase());
  // Explicit SPA stack → not static (even before package.json is written).
  if (stack.some((s) => /^(react|vite|next|vue|svelte|nuxt|remix|astro)$/.test(s) || /react|vite|next|vue|svelte/.test(s))) {
    return false;
  }
  // Real backend entry in the tree → not static.
  // Do NOT match frontend src/main.js — that is the usual static game entry.
  if (
    paths.some((p) =>
      /(^|\/)(server|backend)(\.[jt]sx?|\.mjs|\.cjs)?$/.test(p)
      || /(^|\/)(app|main)\.py$/.test(p)
      || /(^|\/)app\.(go|rs)$/.test(p),
    )
  ) {
    return false;
  }
  // HTML (or empty tree) without package.json → static preview via serve.
  return true;
}

/** Directory argument for `npx serve` based on where HTML lives. */
export function staticServeRoot(treePaths: string[]): string {
  const html = treePaths
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => /\.html?$/i.test(p));
  if (html.length > 0 && html.every((p) => p === 'src' || p.startsWith('src/'))) {
    return 'src';
  }
  return '.';
}

export function staticServeScript(port: number, root = '.'): string {
  const rootArg = root === '.' ? '' : ` ${root}`;
  return `npx --yes serve -l ${port}${rootArg}`.trim();
}

/** True when a failed runtime looks like missing toolchain / wrong stack. */
export function shouldFallbackToStaticServe(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    /not allowed/.test(e)
    || /не отвечает/.test(e)
    || /unhealthy|enoent|cannot find module|err_module_not_found/.test(e)
    || /exceeded|лимит перезапуск/.test(e)
    || /\bvite\b/.test(e)
  );
}
