// ============================================================================
// db-init.mjs — кросс-платформенная инициализация БД.
// ============================================================================
//
// Запускается через `node scripts/db-init.mjs` или `bun scripts/db-init.mjs`.
// Работает на Windows, macOS, Linux без зависимости от bash.
//
// Логика (идемпотентная):
//   1. Если db/custom.db существует — НЕ делаем prisma db push
//      (Prisma падает на vec_virtual virtual table при сравнении схемы),
//      но применяем additive schema patches (новые колонки/таблицы).
//   2. Если БД нет — запускаем `prisma db push`.
//   3. Полный wipe + recreate: `bun run db:force-push`.
//
// Замена для `bun run db:push` на Windows, где bash-скрипты ломаются
// из-за CRLF line endings.

import { existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = resolve(__dirname, '..');
const DB_DIR = join(PROJECT_DIR, 'db');

// ============================================================================
// Resolve DB path — mirrors lib/paths.ts resolveDbPath() logic.
// Reads DATABASE_URL from .env (or process.env), strips `file:` prefix and
// leading `../` (which exist because Prisma resolves relative to prisma/
// schema.prisma, one level below project root), then resolves against
// PROJECT_DIR. This ensures the script checks the SAME file Prisma creates.
// ============================================================================
function resolveDbPath() {
  let dbUrl = process.env.DATABASE_URL;
  // Try reading from .env if not in process.env
  if (!dbUrl) {
    const envPath = join(PROJECT_DIR, '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf8');
      const match = envContent.match(/^DATABASE_URL\s*=\s*(.+)$/m);
      if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  let raw = dbUrl?.replace(/^file:/, '') || join('db', 'custom.db');
  // Strip leading "../" or "..\\" — Prisma lives in <root>/prisma/ and uses
  // "../" to reach <root>/db/. We're already at PROJECT_DIR, so drop them.
  while (raw.startsWith('../') || raw.startsWith('..\\')) {
    raw = raw.slice(3);
  }
  if (isAbsolute(raw)) return raw;
  return resolve(PROJECT_DIR, raw);
}

const DB_FILE = resolveDbPath();
const DB_FILE_DIR = dirname(DB_FILE);

// --force flag: удаляем существующую БД перед prisma db push.
// Полезно когда схема изменилась и старая БД несовместима.
const forceMode = process.argv.includes('--force');

console.log('[db-init] Checking database...');
console.log(`[db-init] DB path: ${DB_FILE}`);

if (forceMode && existsSync(DB_FILE)) {
  console.log(`[db-init] --force: removing existing database file ${DB_FILE}`);
  try {
    unlinkSync(DB_FILE);
    // Also remove WAL/SHM sidecar files if present
    for (const ext of ['-wal', '-shm', '-journal']) {
      const sidecar = DB_FILE + ext;
      if (existsSync(sidecar)) {
        unlinkSync(sidecar);
        console.log(`[db-init]   deleted: ${sidecar}`);
      }
    }
  } catch (e) {
    console.error(`[db-init] Failed to remove DB file:`, e.message);
    process.exit(1);
  }
}

if (existsSync(DB_FILE) && !forceMode) {
  console.log(`[db-init] Database already exists — skipping prisma db push.`);
  // Additive patches (new columns/tables) without wiping data / fighting vec_virtual.
  try {
    const { applySchemaPatchesTo } = await import('./lib/apply-schema-patches.mjs');
    const result = applySchemaPatchesTo(DB_FILE);
    if (result.applied.length > 0) {
      console.log(`[db-init] Schema patches applied: ${result.applied.join(', ')}`);
    } else {
      console.log('[db-init] Schema patches: up to date');
    }
  } catch (e) {
    console.error('[db-init] Schema patches failed:', e.message);
    console.error('[db-init] Try: node scripts/migrate-chat-attachments.mjs');
    process.exit(1);
  }
  console.log('[db-init] Full rebuild (wipes data): bun run db:force-push');
  process.exit(0);
}

// Ensure db/ directory exists (prisma db push creates the file, but not the dir)
if (!existsSync(DB_FILE_DIR)) {
  mkdirSync(DB_FILE_DIR, { recursive: true });
  console.log(`[db-init] Created directory: ${DB_FILE_DIR}`);
}

console.log('[db-init] Database not found — running prisma db push...');

try {
  // Run prisma db push from project root.
  // bunx if running under bun, npx otherwise. Both work cross-platform.
  const isBun = process.env.npm_execpath?.includes('bun') || process.versions.bun;
  const cmd = isBun ? 'bunx prisma db push' : 'npx prisma db push';
  execSync(cmd, {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('[db-init] Done.');
} catch (e) {
  console.error('[db-init] prisma db push failed:', e.message);
  process.exit(1);
}
