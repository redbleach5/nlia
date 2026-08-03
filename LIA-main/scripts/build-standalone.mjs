// ============================================================================
// build-standalone.mjs — кросс-платформенная сборка для production deployment.
// ============================================================================
//
// Заменяет Unix-only `cp -r` в build скрипте. Работает на Windows/macOS/Linux.
//
// Шаги:
//   1. next build (создаёт .next/standalone/)
//   2. Копирует .next/static → .next/standalone/.next/static
//   3. Копирует public → .next/standalone/public
//
// Запуск:
//   bun run build:standalone
//   node scripts/build-standalone.mjs

import { existsSync, cpSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = resolve(__dirname, '..');
const NEXT_DIR = join(PROJECT_DIR, '.next');
const STANDALONE_DIR = join(NEXT_DIR, 'standalone');
const STATIC_SRC = join(NEXT_DIR, 'static');
const PUBLIC_SRC = join(PROJECT_DIR, 'public');

console.log('[build] Running next build...');

try {
  const isBun = process.env.npm_execpath?.includes('bun') || process.versions.bun;
  const cmd = isBun ? 'bunx next build' : 'npx next build';
  execSync(cmd, {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch (e) {
  console.error('[build] next build failed:', e.message);
  process.exit(1);
}

console.log('[build] Copying static files to standalone...');

if (!existsSync(STANDALONE_DIR)) {
  console.error(`[build] Standalone dir not found: ${STANDALONE_DIR}`);
  console.error('[build] Make sure next.config.ts has `output: "standalone"`');
  process.exit(1);
}

// Copy .next/static → .next/standalone/.next/static
const staticDest = join(STANDALONE_DIR, '.next', 'static');
if (existsSync(staticDest)) rmSync(staticDest, { recursive: true, force: true });
if (existsSync(STATIC_SRC)) {
  mkdirSync(join(STANDALONE_DIR, '.next'), { recursive: true });
  cpSync(STATIC_SRC, staticDest, { recursive: true });
  console.log(`[build]   ${STATIC_SRC} → ${staticDest}`);
}

// Copy public → .next/standalone/public
const publicDest = join(STANDALONE_DIR, 'public');
if (existsSync(publicDest)) rmSync(publicDest, { recursive: true, force: true });
if (existsSync(PUBLIC_SRC)) {
  cpSync(PUBLIC_SRC, publicDest, { recursive: true });
  console.log(`[build]   ${PUBLIC_SRC} → ${publicDest}`);
}

console.log('[build] Done. Standalone server at:', STANDALONE_DIR);
console.log('[build] Run with: bun .next/standalone/server.js');
