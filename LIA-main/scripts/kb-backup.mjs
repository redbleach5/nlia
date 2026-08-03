// ============================================================================
// kb-backup.mjs — атомарный backup SQLite DB через Online Backup API.
// ============================================================================
//
// Запуск:
//   bun run kb:backup [path]
//   bun run kb:backup                    # → db/backup-YYYY-MM-DD-HHMMSS.db
//   bun run kb:backup /tmp/my-backup.db  # → /tmp/my-backup.db
//
// См. BACKUP.md в корне репо.

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { resolveDbPath } from './lib/resolve-db-path.mjs';

const targetArg = process.argv[2];
const sourceDbPath = resolveDbPath(process.env.DATABASE_URL);

let backupPath;
if (targetArg) {
  backupPath = path.resolve(targetArg);
} else {
  const dbDir = path.dirname(sourceDbPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  backupPath = path.join(dbDir, `backup-${ts}.db`);
}

if (!existsSync(sourceDbPath)) {
  console.error(`❌ Source DB not found: ${sourceDbPath}`);
  console.error('   Run `bun run db:push` first to initialize the database.');
  process.exit(1);
}

mkdirSync(path.dirname(backupPath), { recursive: true });

console.log(`📦 Backing up SQLite database`);
console.log(`   Source: ${sourceDbPath}`);
console.log(`   Target: ${backupPath}`);

// Not readonly — wal_checkpoint needs a write connection
const db = new Database(sourceDbPath);

try {
  console.log('   Checkpointing WAL...');
  db.pragma('wal_checkpoint(TRUNCATE)');

  console.log('   Creating atomic snapshot...');
  await db.backup(backupPath);

  console.log(`✓ Backup created: ${backupPath}`);
} catch (e) {
  console.error(`❌ Backup failed: ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}

const walPath = `${sourceDbPath}-wal`;
const shmPath = `${sourceDbPath}-shm`;
if (existsSync(walPath)) {
  copyFileSync(walPath, `${backupPath}-wal`);
  console.log(`   Copied WAL: ${backupPath}-wal`);
}
if (existsSync(shmPath)) {
  copyFileSync(shmPath, `${backupPath}-shm`);
  console.log(`   Copied SHM: ${backupPath}-shm`);
}

console.log('');
console.log('To restore (stop Lia first):');
console.log(`  bun run kb:restore ${backupPath}`);
console.log('Docs: BACKUP.md');
