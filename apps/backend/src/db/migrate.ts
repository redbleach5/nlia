/**
 * Drizzle-orm migrator entrypoint. Used by `npm run db:migrate`.
 *
 * M0 stub: the drizzle-kit-generated SQL lives in ../../db/migrations/*.sql.
 * Once the first migration exists, drizzle-orm's migrator will replay them
 * inside the same getDb() connection (sqlite-vec stays loaded).
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb, closeDb } from "./client.js";
import { logger } from "../util/logger.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function runMigrations(): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../../db/migrations");
  if (!existsSync(migrationsFolder)) {
    logger.warn(
      { migrationsFolder },
      "no migrations folder — skipping (tables created by getDb)",
    );
    return;
  }
  migrate(db, { migrationsFolder });
  logger.info({ migrationsFolder }, "migrations applied");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
    console.log("✓ migrations applied");
  } catch (err) {
    console.error("✗ migration failed:", err);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
