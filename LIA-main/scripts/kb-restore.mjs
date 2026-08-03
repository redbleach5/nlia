// ============================================================================
// kb-restore.mjs — восстановить SQLite DB из файла backup-*.db
// ============================================================================
//
// Запуск:
//   bun run kb:restore path/to/backup-….db
//   bun run kb:restore path/to/backup-….db --yes   # без подтверждения
//
// Перед заменой:
//   - останови `bun run dev` / production server
//   - делается safety-копия текущего custom.db → db/pre-restore-….db
//   - удаляются custom.db-wal / custom.db-shm (иначе SQLite подмешает старый WAL)
//
// См. BACKUP.md

import { copyFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { resolveDbPath } from './lib/resolve-db-path.mjs';

const backupArg = process.argv[2];
const autoYes = process.argv.includes('--yes') || process.argv.includes('-y');

if (!backupArg) {
  console.error('Usage: bun run kb:restore <path-to-backup.db> [--yes]');
  console.error('Example: bun run kb:restore db/backup-sweet-era-2026-07-23.db');
  process.exit(1);
}

const backupPath = path.resolve(backupArg);
const liveDbPath = resolveDbPath(process.env.DATABASE_URL);
const liveDir = path.dirname(liveDbPath);
const walPath = `${liveDbPath}-wal`;
const shmPath = `${liveDbPath}-shm`;

if (!existsSync(backupPath)) {
  console.error(`❌ Backup not found: ${backupPath}`);
  process.exit(1);
}

if (path.resolve(backupPath) === path.resolve(liveDbPath)) {
  console.error('❌ Backup path is the live DB — refuse to overwrite from itself.');
  process.exit(1);
}

console.log('♻  Restore Lia SQLite memory');
console.log(`   From: ${backupPath}`);
console.log(`   Into: ${liveDbPath}`);
console.log('');
console.log('⚠  Stop `bun run dev` / Lia server before continuing.');
console.log('   Otherwise the running process may rewrite the DB immediately.');

async function confirm() {
  if (autoYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Type YES to replace live DB: ', resolve);
  });
  rl.close();
  return answer.trim() === 'YES';
}

if (!(await confirm())) {
  console.error('Cancelled.');
  process.exit(2);
}

mkdirSync(liveDir, { recursive: true });

// Safety copy of current live DB (if any)
if (existsSync(liveDbPath)) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safetyPath = path.join(liveDir, `pre-restore-${ts}.db`);
  copyFileSync(liveDbPath, safetyPath);
  console.log(`✓ Safety copy: ${safetyPath}`);
}

// Drop WAL/SHM so SQLite does not merge stale journal into the restored file
for (const p of [walPath, shmPath]) {
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`   Removed ${path.basename(p)}`);
  }
}

// Atomic-ish replace: copy to temp then rename
const tmpPath = `${liveDbPath}.restoring`;
copyFileSync(backupPath, tmpPath);
renameSync(tmpPath, liveDbPath);

console.log(`✓ Restored: ${liveDbPath}`);
console.log('Next: bun run db:push  (additive schema patches, no wipe)');
console.log('Then: bun run dev');
