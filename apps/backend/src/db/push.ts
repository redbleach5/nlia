/**
 * `drizzle-kit push`-style imperative schema apply.
 *
 * Uses drizzle-orm's push API to sync schema.ts → SQLite without generating
 * migration files. Ideal for M1 dev; M2+ will use drizzle-kit generate to
 * produce versioned migrations for the v2→v3 migration script (per § 12).
 *
 * CLI entrypoint: `npm run db:push` → tsx src/db/push.ts
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb, closeDb } from "./client.js";
import { logger } from "../util/logger.js";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Apply schema. Strategy:
 *   1. If db/migrations folder exists with SQL files → run drizzle migrator
 *      (replays _journal.json + 0000_*.sql etc).
 *   2. Else → fall back to idempotent CREATE TABLE IF NOT EXISTS for the M0
 *      tables (kb_vec_virtual, schema_meta) — handled by getDb(). M1 tables
 *      will be created on first `drizzle-kit generate && npm run db:migrate`.
 *
 * The migrations folder is resolved relative to the backend package
 * (apps/backend/db/migrations), NOT process.cwd() — so the backend can be
 * started from the monorepo root or from apps/backend and still find migrations.
 */
export function pushSchema(): void {
  const sqlite = getDb();

  // Resolve migrations folder relative to this module: apps/backend/src/db/push.ts
  // → ../../db/migrations = apps/backend/db/migrations
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../../db/migrations");

  if (existsSync(migrationsFolder)) {
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    logger.info({ migrationsFolder }, "drizzle migrations applied");

    // Seed schema_meta (idempotent — INSERT OR IGNORE)
    sqlite.exec(`
      INSERT OR IGNORE INTO schema_meta (key, value) VALUES
        ('schema_version', 'm1'),
        ('kb_vec_dim', '768'),
        ('kb_tokenizer_version', '1');
    `);
  } else {
    logger.warn(
      { migrationsFolder },
      "no db/migrations folder — only kb_vec_virtual created. Run `npm run db:generate` then `npm run db:push`.",
    );
  }

  // Smoke: list tables so we can verify in logs
  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  logger.info({ tables: tables.map((t) => t.name) }, "schema applied");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    pushSchema();
    console.log("✓ schema pushed");
  } catch (err) {
    console.error("✗ schema push failed:", err);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
