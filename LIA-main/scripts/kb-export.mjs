// ============================================================================
// kb-export.mjs — export KB + settings в tarball для переноса между машинами.
// ============================================================================
//
// Запуск:
//   bun run kb:export [path]
//   bun run kb:export                    # → lia-export-YYYY-MM-DD.tar.gz
//   bun run kb:export /tmp/my-backup.tar.gz
//
// Что включает:
//   - db/custom.db + db/custom.db-wal + db/custom.db-shm (SQLite с WAL)
//   - .env (с LIA_ENCRYPTION_KEY — критично для зашифрованных tokens)
//   - kb-uploads/ (загруженные документы)
//   - manifest.json с метаданными (версия, дата, размер)
//
// Что НЕ включает:
//   - node_modules/ (восстанавливается через bun install)
//   - .next/ (build artifacts)
//
// Restore:
//   bun run kb:import <path>    — распаковать в текущую директорию
//
// ВАЖНО: .env содержит LIA_ENCRYPTION_KEY. Без него зашифрованные поля в БД не расшифровать. Храни export в безопасном месте.

import { createWriteStream, createReadStream, existsSync, statSync, readFile, writeFile, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

// ============================================================================
// Export
// ============================================================================

async function exportData(targetPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = targetPath || resolve(PROJECT_ROOT, `lia-export-${timestamp}.tar.gz`);

  console.log('📦 Exporting Lia data...\n');

  // Verify required files exist
  const dbPath = resolve(PROJECT_ROOT, 'db', 'custom.db');
  const envPath = resolve(PROJECT_ROOT, '.env');
  const uploadsPath = resolve(PROJECT_ROOT, 'download', 'lia-artifacts', 'kb-uploads');

  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    console.error('   Run `bun run db:push` first.');
    process.exit(1);
  }
  if (!existsSync(envPath)) {
    console.error(`❌ .env not found: ${envPath}`);
    console.error('   Run `bun run setup` first.');
    process.exit(1);
  }

  // Create manifest
  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    files: {},
  };

  // DB files
  for (const ext of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${ext}`;
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      manifest.files[`db/custom.db${ext}`] = {
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    }
  }

  // .env
  const envStat = statSync(envPath);
  manifest.files['.env'] = {
    size: envStat.size,
    mtime: envStat.mtime.toISOString(),
  };

  // kb-uploads (count files)
  if (existsSync(uploadsPath)) {
    const result = spawnSync('find', [uploadsPath, '-type', 'f'], { stdio: 'pipe' });
    const files = result.stdout?.toString().trim().split('\n').filter(Boolean);
    manifest.files['kb-uploads/'] = {
      fileCount: files.length,
      totalSize: files.reduce((sum, f) => {
        try { return sum + statSync(f).size; } catch { return sum; }
      }, 0),
    };
  }

  // Write manifest to temp file
  const manifestPath = resolve(PROJECT_ROOT, '.lia-export-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Create tarball
  console.log('Creating tarball...');
  const tarArgs = [
    'czf', outputPath,
    '-C', PROJECT_ROOT,
    'db/custom.db',
    'db/custom.db-wal',
    'db/custom.db-shm',
    '.env',
    '.lia-export-manifest.json',
  ];

  // Add kb-uploads if exists
  if (existsSync(uploadsPath)) {
    // tar needs relative path from -C
    const relUploads = 'download/lia-artifacts/kb-uploads';
    tarArgs.push(relUploads);
  }

  // Filter out non-existent files
  const existingArgs = tarArgs.filter(arg => {
    if (arg === 'czf' || arg === outputPath || arg === '-C' || arg === PROJECT_ROOT) return true;
    if (arg.startsWith('db/') || arg === '.env' || arg === '.lia-export-manifest.json') {
      return existsSync(resolve(PROJECT_ROOT, arg));
    }
    return true;
  });

  const tarResult = spawnSync('tar', existingArgs.filter(arg => {
    // Remove args for non-existent files
    if (arg === 'db/custom.db-wal') return existsSync(resolve(PROJECT_ROOT, 'db/custom.db-wal'));
    if (arg === 'db/custom.db-shm') return existsSync(resolve(PROJECT_ROOT, 'db/custom.db-shm'));
    if (arg === 'download/lia-artifacts/kb-uploads') return existsSync(uploadsPath);
    return true;
  }), { stdio: 'pipe' });

  if (tarResult.status !== 0) {
    console.error('❌ tar failed:', tarResult.stderr?.toString());
    process.exit(1);
  }

  // Cleanup manifest
  try { await import('fs/promises').then(fs => fs.unlink(manifestPath)); } catch { /* ignore */ }

  const outputSize = statSync(outputPath).size;
  console.log(`\n✓ Export created: ${outputPath}`);
  console.log(`   Size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   Files: ${Object.keys(manifest.files).join(', ')}`);
  console.log(`\n   ⚠️  This file contains LIA_ENCRYPTION_KEY and all KB data.`);
  console.log(`   Store it securely. Anyone with this file can decrypt encrypted config fields.`);
}

// ============================================================================
// Import
// ============================================================================

async function importData(sourcePath) {
  if (!sourcePath) {
    console.error('❌ Usage: bun run kb:import <path-to-tar.gz>');
    process.exit(1);
  }

  if (!existsSync(sourcePath)) {
    console.error(`❌ File not found: ${sourcePath}`);
    process.exit(1);
  }

  console.log('📥 Importing Lia data...\n');
  console.log(`   Source: ${sourcePath}`);
  console.log(`   Target: ${PROJECT_ROOT}\n`);

  // Safety check — don't overwrite without backup
  const dbPath = resolve(PROJECT_ROOT, 'db', 'custom.db');
  if (existsSync(dbPath)) {
    console.log('⚠️  Existing database found. Creating backup before import...');
    const { runBackup } = await import('./kb-backup.mjs').catch(() => ({}));
    const backupPath = resolve(PROJECT_ROOT, `db/pre-import-backup-${Date.now()}.db`);
    // Simple copy as backup
    spawnSync('cp', [dbPath, backupPath]);
    console.log(`   Backup: ${backupPath}\n`);
  }

  // Extract tarball
  console.log('Extracting...');
  const tarResult = spawnSync('tar', ['xzf', sourcePath, '-C', PROJECT_ROOT], { stdio: 'pipe' });

  if (tarResult.status !== 0) {
    console.error('❌ tar extraction failed:', tarResult.stderr?.toString());
    process.exit(1);
  }

  // Verify manifest
  const manifestPath = resolve(PROJECT_ROOT, '.lia-export-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    console.log(`\n✓ Import complete`);
    console.log(`   Exported at: ${manifest.exportedAt}`);
    console.log(`   Files: ${Object.keys(manifest.files).join(', ')}`);
    // Cleanup manifest
    try { await import('fs/promises').then(fs => fs.unlink(manifestPath)); } catch { /* ignore */ }
  } else {
    console.log('\n✓ Import complete (no manifest found)');
  }

  console.log('\nNext steps:');
  console.log('  1. Run `bun install` to restore dependencies');
  console.log('  2. Run `bun run db:push` to apply schema (no data loss)');
  console.log('  3. Run `bun run dev` to start the server');
  console.log('  4. Verify KB sources work in Settings → Knowledge Base');
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2];
const targetPath = process.argv[3];

if (command === 'import') {
  importData(targetPath).catch(e => {
    console.error('❌ Import failed:', e.message);
    process.exit(1);
  });
} else {
  // Default: export
  exportData(command).catch(e => {
    console.error('❌ Export failed:', e.message);
    process.exit(1);
  });
}
