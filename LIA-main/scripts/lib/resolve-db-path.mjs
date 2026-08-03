// Resolve DATABASE_URL / default path the same way as src/lib/paths.ts
// (plain .mjs so Node scripts don't import TypeScript).

import path from 'path';

const PROJECT_ROOT = process.env.LIA_ROOT || process.cwd();

/**
 * @param {string | undefined} dbUrl
 * @returns {string}
 */
export function resolveDbPath(dbUrl) {
  let raw = dbUrl?.replace(/^file:/, '') || path.join('db', 'custom.db');
  while (raw.startsWith('../') || raw.startsWith('..\\')) {
    raw = raw.slice(3);
  }
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.join(PROJECT_ROOT, raw);
}

export function projectRoot() {
  return PROJECT_ROOT;
}
