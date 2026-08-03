// Cross-platform path resolution for Lia v2.
//
// All file paths should go through this module — no hardcoded absolute paths
// anywhere else. Works on macOS, Windows, Linux.
//
// The project root is detected via:
//   1. LIA_ROOT env var (if set)
//   2. process.cwd() (default — works when `bun run dev` is called from project root)
//
// DATABASE_URL in .env should be:
//   DATABASE_URL=file:../db/custom.db
//
// CRITICAL: Prisma resolves this URL relative to `prisma/schema.prisma` (i.e.
// Lia-v2/prisma/), so `file:../db/custom.db` becomes `Lia-v2/db/custom.db`.
// `resolveDbPath()` below resolves the same URL relative to PROJECT_ROOT (i.e.
// Lia-v2/), so `file:../db/custom.db` ALSO becomes `Lia-v2/db/custom.db`.
// Both layers now open the SAME file. Earlier (file:./db/custom.db) the two
// layers disagreed and silently wrote to two different SQLite files.
//
// Optional: set LIA_ROOT when the process cwd is not the project root.

import path from 'path';
import os from 'os';
import { existsSync } from 'fs';

// ============================================================================
// Project root
// ============================================================================
export const PROJECT_ROOT = process.env.LIA_ROOT || process.cwd();

// ============================================================================
// Standard directories
// ============================================================================
export const PATHS = {
  root: PROJECT_ROOT,
  db: path.join(PROJECT_ROOT, 'db'),
  dbFile: path.join(PROJECT_ROOT, 'db', 'custom.db'),
  artifacts: path.join(PROJECT_ROOT, 'download', 'lia-artifacts'),
  /** Create Runtime PID files — survive Next process restart for orphan sweep. */
  runtimePids: path.join(PROJECT_ROOT, 'download', 'lia-runtime-pids'),
  public: path.join(PROJECT_ROOT, 'public'),
  publicModels: path.join(PROJECT_ROOT, 'public', 'models'),
  logs: path.join(PROJECT_ROOT, 'logs'),
} as const;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a path that may be:
 *   - absolute (returned as-is, normalized)
 *   - relative (resolved against PROJECT_ROOT)
 */
function resolveProjectPath(p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.join(PROJECT_ROOT, p);
}

/**
 * Convert a DB path from .env to a filesystem path.
 *
 * Prisma's SQLite URL format: `file:../db/custom.db` or `file:/abs/path/db.db`
 * We strip the `file:` prefix and resolve the rest.
 *
 * The path is resolved against PROJECT_ROOT (NOT the cwd of whoever started
 * the process — so `LIA_ROOT` / non-root cwd still hit the same DB file).
 *
 * IMPORTANT: This must stay in sync with how Prisma resolves the same URL.
 * Prisma resolves `file:...` relative to `prisma/schema.prisma` (which lives
 * in <root>/prisma/, one level below the project root). To land both layers
 * on the same physical file we use:
 *   DATABASE_URL=file:../db/custom.db
 * Prisma resolves that to <root>/db/custom.db. Here we strip any leading
 * "../" or "..\\" segments (they exist because Prisma lives one dir below
 * the project root) before joining against PROJECT_ROOT, so the result is
 * also <root>/db/custom.db.
 */
export function resolveDbPath(dbUrl: string | undefined): string {
  let raw = dbUrl?.replace(/^file:/, '') || path.join('db', 'custom.db');
  // Strip leading "../" or "..\\" — these exist because DATABASE_URL is
  // written for Prisma (which lives in <root>/prisma/ and uses "../" to
  // reach <root>/db/). We are already at PROJECT_ROOT, so we drop them.
  while (raw.startsWith('../') || raw.startsWith('..\\')) {
    raw = raw.slice(3);
  }
  return resolveProjectPath(raw);
}

/**
 * Resolve the sqlite-vec native binary path.
 *
 * Searches multiple candidate locations to support:
 *   - Standard install: <root>/node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>
 *   - Monorepo: <root>/../../node_modules/...
 *   - Optional bundle: <root>/resources/vec0.<ext>
 */
export function resolveSqliteVecPath(): string {
  const ext = process.platform === 'win32' ? 'dll'
    : process.platform === 'darwin' ? 'dylib'
    : 'so';
  const osName = process.platform === 'win32' ? 'windows' : process.platform;
  const pkgName = `sqlite-vec-${osName}-${process.arch}`;
  const filename = `vec0.${ext}`;

  const candidates = [
    // Standard install
    path.join(PROJECT_ROOT, 'node_modules', pkgName, filename),
    // Monorepo: project is in packages/<name>
    path.join(PROJECT_ROOT, '..', '..', 'node_modules', pkgName, filename),
    // P3-4 fix (M-DB-4.3): use os.homedir() instead of env vars with '~' fallback.
    // Previous code used `process.env.HOME || process.env.USERPROFILE || '~'` —
    // if both env vars were unset, fell back to literal '~' which path.join
    // treats as a directory name, not home. os.homedir() is reliable.
    path.join(os.homedir(), '.bun', 'install', 'cache', pkgName, filename),
    // Optional: native binary dropped into <root>/resources/
    path.join(PROJECT_ROOT, 'resources', filename),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // skip — fs may not be available in some contexts
    }
  }

  throw new Error(
    `sqlite-vec native binary not found. Looked for:\n${candidates.join('\n')}\n` +
    `Install it: bun add ${pkgName}`
  );
}

/**
 * Sanitize a filename — strip path separators, prevent traversal.
 * Used for user-provided filenames (e.g., save_artifact).
 *
 * P3-4 fix (M-DB-4.2): also strip `..` sequences. Previously, a filename like
 * `..secret` survived sanitization and could be used for traversal if joined
 * naively downstream. Now `..` is replaced with `_`.
 */
export function sanitizeFilename(filename: string): string {
  // Replace path separators and dangerous chars
  const cleaned = filename
    .replace(/[\\/:]/g, '_')  // path separators → underscore
    // P3-4 fix: strip `..` sequences (path traversal)
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, '_')     // whitespace → underscore
    .replace(/^\./, '_')      // no leading dot (hidden files)
    .toLowerCase();

  // Whitelist: letters, digits, dots, hyphens, underscores
  const safe = cleaned.replace(/[^a-zа-яё0-9._-]/gi, '_');

  // Limit length
  return safe.slice(0, 200) || 'untitled';
}
