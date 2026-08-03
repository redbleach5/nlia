// ============================================================================
// lia.project.json — schema + parse/serialize (client + server safe).
// ============================================================================

import { z } from 'zod';
import type { ProjectDesign, ProjectKind } from './types';
import { PROJECT_KINDS, PREVIEW_TYPES } from './types';
import {
  isStaticWebDesign,
  normalizeRuntimeScript,
  staticServeScript,
} from './script-normalize';

export const PROJECT_MANIFEST_FILENAME = 'lia.project.json';

/** Default iframe preview port — must not collide with Lia (3000). */
export const DEFAULT_IFRAME_PORT = 5173;

/** Ports reserved by the host app — remap agent preview away from these. */
export const RESERVED_PREVIEW_PORTS = new Set([3000]);

const KIND_ALIASES: Record<string, ProjectKind> = {
  'web-game': 'game',
  webgame: 'game',
  gameapp: 'game',
  webapp: 'web',
  website: 'web',
  site: 'web',
  page: 'web',
  landing: 'web',
  application: 'web',
  app: 'web',
  node: 'api',
  express: 'api',
  fastapi: 'api',
  flask: 'api',
  utility: 'cli',
  tool: 'cli',
};

function isProjectKind(v: string): v is ProjectKind {
  return (PROJECT_KINDS as readonly string[]).includes(v);
}

function defaultScriptsForKind(kind: ProjectKind, port: number): {
  install?: string;
  dev?: string;
  start?: string;
} {
  if (kind === 'web' || kind === 'game') {
    return {
      dev: staticServeScript(port),
      start: staticServeScript(port),
    };
  }
  if (kind === 'api') {
    return {
      install: 'npm install',
      dev: 'node server.js',
      start: 'node server.js',
    };
  }
  return {
    start: 'node main.js',
    dev: 'node main.js',
  };
}

function treePathsOf(tree: unknown): string[] {
  if (!Array.isArray(tree)) return [];
  return tree
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        return (entry as { path: string }).path;
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * Liberal coercion for weak-model propose_design payloads:
 * kind aliases, tree strings/{type}, default iframe port, static serve over bare vite.
 */
export function coerceProjectDesignInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };

  if (typeof o.kind === 'string') {
    const key = o.kind.toLowerCase().trim();
    if (KIND_ALIASES[key]) o.kind = KIND_ALIASES[key];
    else if (isProjectKind(key)) o.kind = key;
  }

  if (Array.isArray(o.tree)) {
    o.tree = o.tree.map((entry) => {
      if (typeof entry === 'string' && entry.trim()) {
        return { path: entry.trim(), role: 'file' };
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const e = { ...(entry as Record<string, unknown>) };
      if (typeof e.role !== 'string' || !e.role.trim()) {
        if (typeof e.type === 'string' && e.type.trim()) e.role = e.type;
        else if (typeof e.path === 'string') e.role = 'file';
      }
      return e;
    });
  }

  if (!Array.isArray(o.stack) || o.stack.length === 0) {
    o.stack = ['html', 'css', 'javascript'];
  }

  const kind: ProjectKind = isProjectKind(String(o.kind ?? ''))
    ? (o.kind as ProjectKind)
    : 'web';

  let preview: Record<string, unknown> =
    o.preview && typeof o.preview === 'object' && !Array.isArray(o.preview)
      ? { ...(o.preview as Record<string, unknown>) }
      : {};

  const previewType =
    typeof preview.type === 'string' && (PREVIEW_TYPES as readonly string[]).includes(preview.type)
      ? preview.type
      : kind === 'cli' || kind === 'script'
        ? 'terminal'
        : 'iframe';
  preview.type = previewType;

  if (previewType === 'iframe') {
    let port =
      typeof preview.port === 'number' && Number.isFinite(preview.port)
        ? Math.trunc(preview.port)
        : DEFAULT_IFRAME_PORT;
    if (port < 1024 || port > 65535 || RESERVED_PREVIEW_PORTS.has(port)) {
      port = DEFAULT_IFRAME_PORT;
    }
    preview.port = port;
  }
  o.preview = preview;

  const port =
    typeof preview.port === 'number' ? preview.port : DEFAULT_IFRAME_PORT;

  const paths = treePathsOf(o.tree);
  const stackArr = Array.isArray(o.stack) ? o.stack.map(String) : [];
  const spaIntent = stackArr.some((s) => /react|vite|next|vue|svelte|nuxt|remix|astro/i.test(s));
  const staticWeb = isStaticWebDesign({
    kind,
    stack: stackArr,
    treePaths: paths,
    preset: typeof o.preset === 'string' ? o.preset : undefined,
  });

  let scripts: Record<string, unknown> =
    o.scripts && typeof o.scripts === 'object' && !Array.isArray(o.scripts)
      ? { ...(o.scripts as Record<string, unknown>) }
      : {};

  // Explicit SPA stack → keep vite path (don't collapse to static serve).
  if (spaIntent && previewType === 'iframe' && !staticWeb) {
    o.preset = typeof o.preset === 'string' && o.preset ? o.preset : 'vite-react';
    if (!paths.some((p) => /(^|\/)package\.json$/i.test(p))) {
      const tree = Array.isArray(o.tree) ? [...o.tree] : [];
      tree.unshift({ path: 'package.json', role: 'зависимости и scripts' });
      o.tree = tree;
    }
    const vite = `npx --yes vite --host 127.0.0.1 --port ${port}`;
    const hasDev = typeof scripts.dev === 'string' && scripts.dev.trim().length > 0;
    const hasStart = typeof scripts.start === 'string' && scripts.start.trim().length > 0;
    if (!hasDev) scripts.dev = vite;
    if (!hasStart) scripts.start = vite;
    if (!scripts.install) scripts.install = 'npm install';
    for (const key of ['dev', 'start'] as const) {
      const val = scripts[key];
      if (typeof val === 'string' && val.trim()) {
        scripts[key] = normalizeRuntimeScript(val, port);
      }
    }
  } else if (staticWeb && previewType === 'iframe') {
    // Static HTML games/sites: force root layout + npx serve (no src/, no bare vite).
    const serve = staticServeScript(port, '.');
    scripts = { ...scripts, dev: serve, start: serve };
    o.stack = ['html', 'css', 'javascript'];
    o.tree = [
      { path: 'index.html', role: 'страница / точка входа' },
      { path: 'style.css', role: 'стили' },
      { path: 'script.js', role: 'логика' },
      { path: 'lia.project.json', role: 'манифест Create Runtime' },
    ];
    o.entry = 'index.html';
    if (kind === 'game') o.preset = 'static-game';
    else o.preset = 'static-web';
  } else {
    const hasDev = typeof scripts.dev === 'string' && scripts.dev.trim().length > 0;
    const hasStart = typeof scripts.start === 'string' && scripts.start.trim().length > 0;
    if (!hasDev && !hasStart) {
      scripts = { ...scripts, ...defaultScriptsForKind(kind, port) };
    }
    for (const key of ['dev', 'start'] as const) {
      const val = scripts[key];
      if (typeof val === 'string' && val.trim()) {
        scripts[key] = normalizeRuntimeScript(val, port);
      }
    }
  }

  o.scripts = scripts;

  if (typeof o.acceptance !== 'string' || !o.acceptance.trim()) {
    o.acceptance =
      previewType === 'iframe'
        ? 'Preview открывается на localhost, страница без JS-ошибок, основной сценарий работает.'
        : 'Скрипт/процесс стартует без ошибки и выполняет задачу.';
  }

  if (o.createdBy !== 'lia') o.createdBy = 'lia';

  return o;
}

export const projectDesignSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(PROJECT_KINDS),
  preset: z.string().min(1).max(40).optional(),
  stack: z.array(z.string().min(1).max(40)).min(1).max(12),
  tree: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        role: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(40),
  scripts: z
    .object({
      install: z.string().min(1).max(300).optional(),
      dev: z.string().min(1).max(300).optional(),
      build: z.string().min(1).max(300).optional(),
      start: z.string().min(1).max(300).optional(),
    })
    .default({}),
  preview: z.object({
    type: z.enum(PREVIEW_TYPES),
    port: z.number().int().min(1024).max(65535).optional(),
    url: z.string().max(300).optional(),
  }),
  entry: z.string().max(200).optional(),
  acceptance: z.string().min(1).max(500),
  createdBy: z.literal('lia').default('lia'),
});

export type ProjectDesignInput = z.input<typeof projectDesignSchema>;

export function parseProjectDesign(raw: unknown):
  | { ok: true; design: ProjectDesign }
  | { ok: false; error: string } {
  const coerced = coerceProjectDesignInput(raw);
  const parsed = projectDesignSchema.safeParse(coerced);
  if (!parsed.success) {
    const msg = parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: msg || 'invalid design' };
  }
  const design = parsed.data as ProjectDesign;
  // After coerce these should not fire — keep as safety net for direct schema callers.
  if (design.preview.type === 'iframe' && !design.preview.port) {
    return { ok: false, error: 'preview.port required when preview.type is iframe' };
  }
  if (!design.scripts.dev && !design.scripts.start) {
    return { ok: false, error: 'scripts.dev or scripts.start required' };
  }
  return { ok: true, design };
}

export function parseProjectDesignJson(text: string):
  | { ok: true; design: ProjectDesign }
  | { ok: false; error: string } {
  try {
    return parseProjectDesign(JSON.parse(text) as unknown);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

export function serializeProjectDesign(design: ProjectDesign): string {
  return `${JSON.stringify(design, null, 2)}\n`;
}

/** Minimal design shape for preview URL (client + server). */
export type PreviewDesignLike = {
  entry?: string;
  preview: { type: string; port?: number; url?: string };
};

/** True when entry is a browser-servable HTML document (not SPA/source/API entry). */
export function isBrowserPreviewEntry(entry: string | undefined | null): boolean {
  if (!entry || typeof entry !== 'string') return false;
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return /\.html?$/i.test(normalized);
}

/**
 * Relative FS path of the HTML document that iframe preview must serve.
 * Null when preview is not iframe-HTML (SPA uses `/`, terminal has no document).
 */
export function previewEntryRelativePath(design: PreviewDesignLike): string | null {
  if (design.preview.type !== 'iframe') return null;
  if (!isBrowserPreviewEntry(design.entry)) return null;
  return design.entry!.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Path portion of the iframe preview URL.
 * HTML entry → `/index.html`; SPA/API source entry → `/`.
 */
export function previewDocumentPath(design: PreviewDesignLike): string {
  const rel = previewEntryRelativePath(design);
  return rel ? `/${rel}` : '/';
}

function previewOrigin(design: PreviewDesignLike): string | null {
  if (design.preview.type !== 'iframe' || !design.preview.port) return null;
  const raw = design.preview.url;
  if (
    typeof raw === 'string'
    && (raw.startsWith('http://127.0.0.1') || raw.startsWith('http://localhost'))
  ) {
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  return `http://127.0.0.1:${design.preview.port}`;
}

/** Join origin + document path without double slashes. */
export function joinPreviewOriginPath(origin: string, docPath: string): string {
  const base = origin.replace(/\/+$/, '');
  if (!docPath || docPath === '/') return `${base}/`;
  return `${base}${docPath.startsWith('/') ? docPath : `/${docPath}`}`;
}

/** HTML document path from preview URL (e.g. /index.html → index.html). */
export function htmlEntryFromPreviewUrl(previewUrl: string | null | undefined): string | null {
  if (!previewUrl) return null;
  try {
    const path = new URL(previewUrl).pathname.replace(/^\/+/, '');
    if (path && /\.html?$/i.test(path)) return path;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Local preview URL for iframe (localhost only).
 * Uses design.entry when it is an HTML document; otherwise origin `/` (Vite SPA).
 */
export function previewUrlForDesign(design: PreviewDesignLike): string | null {
  if (design.preview.type !== 'iframe' || !design.preview.port) return null;

  const docPath = previewDocumentPath(design);
  const raw = design.preview.url;
  if (
    typeof raw === 'string'
    && (raw.startsWith('http://127.0.0.1') || raw.startsWith('http://localhost'))
  ) {
    try {
      const u = new URL(raw);
      // Explicit non-root path in preview.url wins (agent/override).
      if (u.pathname && u.pathname !== '/') {
        return raw;
      }
      return joinPreviewOriginPath(`${u.protocol}//${u.host}`, docPath);
    } catch {
      return raw;
    }
  }

  const origin = previewOrigin(design);
  if (!origin) return null;
  return joinPreviewOriginPath(origin, docPath);
}
