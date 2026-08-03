#!/usr/bin/env node
/**
 * Additive SQLite schema patches for existing DBs.
 *
 * Why: `db-init` skips `prisma db push` when custom.db already exists
 * (vec_virtual breaks Prisma's schema diff). New columns/tables must be
 * applied idempotently without wiping data.
 *
 * Usage:
 *   node scripts/lib/apply-schema-patches.mjs
 *   bun run db:patch
 *
 * Also invoked from db-init.mjs and server startup.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '../..');

function resolveDbPath() {
  let dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    const envPath = join(PROJECT_DIR, '.env');
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf8').match(/^DATABASE_URL\s*=\s*(.+)$/m);
      if (match) dbUrl = match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  let raw = dbUrl?.replace(/^file:/, '') || join('db', 'custom.db');
  while (raw.startsWith('../') || raw.startsWith('..\\')) {
    raw = raw.slice(3);
  }
  if (isAbsolute(raw)) return raw;
  return resolve(PROJECT_DIR, raw);
}

/**
 * @param {string} dbPath
 * @returns {{ applied: string[], skipped: string[], dbPath: string }}
 */
export function applySchemaPatchesTo(dbPath) {
  const applied = [];
  const skipped = [];

  if (!existsSync(dbPath)) {
    return { applied, skipped: ['db-missing'], dbPath };
  }

  const db = new Database(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(Message)').all().map((c) => c.name);

    if (!cols.includes('attachmentsJson')) {
      db.exec('ALTER TABLE Message ADD COLUMN attachmentsJson TEXT');
      applied.push('Message.attachmentsJson');
    } else {
      skipped.push('Message.attachmentsJson');
    }

    const agentCols = db.prepare('PRAGMA table_info(AgentTask)').all().map((c) => c.name);
    if (agentCols.length > 0) {
      if (!agentCols.includes('templateName')) {
        db.exec('ALTER TABLE AgentTask ADD COLUMN templateName TEXT');
        applied.push('AgentTask.templateName');
      } else {
        skipped.push('AgentTask.templateName');
      }
    }

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ChatAttachment'`)
      .all();

    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "ChatAttachment" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "episodeId" TEXT NOT NULL,
          "messageId" TEXT,
          "originalName" TEXT NOT NULL,
          "mimeType" TEXT NOT NULL,
          "sizeBytes" INTEGER NOT NULL,
          "kind" TEXT NOT NULL,
          "storageKey" TEXT NOT NULL,
          "textPreview" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE,
          FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "ChatAttachment_episodeId_idx" ON "ChatAttachment"("episodeId");
        CREATE INDEX IF NOT EXISTS "ChatAttachment_messageId_idx" ON "ChatAttachment"("messageId");
        CREATE INDEX IF NOT EXISTS "ChatAttachment_episodeId_messageId_idx" ON "ChatAttachment"("episodeId", "messageId");
      `);
      applied.push('ChatAttachment');
    } else {
      skipped.push('ChatAttachment');
    }

    dropLegacyKbAndDashboardTables(db, applied, skipped);
  } finally {
    db.close();
  }

  return { applied, skipped, dbPath };
}

/**
 * Remove tables dropped from Prisma schema (wave 1/2 cleanup).
 */
function dropLegacyKbAndDashboardTables(db, applied, skipped) {
  for (const table of ['Ticket', 'lia_activity']) {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    if (exists) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
      applied.push(`drop.${table}`);
    } else {
      skipped.push(`drop.${table}`);
    }
  }

  const sourceTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='Source'`)
    .get();
  if (sourceTable) {
    const row = db.prepare(`SELECT COUNT(*) as c FROM Source WHERE type='youtrack'`).get();
    if (row && row.c > 0) {
      db.exec(`DELETE FROM Source WHERE type='youtrack'`);
      applied.push('Source.youtrack.cleanup');
    } else {
      skipped.push('Source.youtrack.cleanup');
    }
  }
}

export function applySchemaPatches() {
  return applySchemaPatchesTo(resolveDbPath());
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = applySchemaPatches();
  if (result.skipped.includes('db-missing')) {
    console.error('[schema-patches] DB not found:', result.dbPath);
    console.error('[schema-patches] Run: bun run db:push');
    process.exit(1);
  }
  if (result.applied.length > 0) {
    console.log('[schema-patches] Applied:', result.applied.join(', '));
  } else {
    console.log('[schema-patches] Up to date (nothing to apply)');
  }
  console.log('[schema-patches] DB:', result.dbPath);
}
