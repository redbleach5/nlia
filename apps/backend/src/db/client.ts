/**
 * SQLite connection + sqlite-vec extension loader.
 *
 * Architecture (per docs/ARCHITECTURE.md § 3.2.4):
 *   - better-sqlite3 for synchronous, native-speed DB access from Node
 *   - sqlite-vec loaded as an extension for KNN vector search
 *   - kb_vec_virtual table created on first run if missing
 *
 * The v0 virtual table mirrors v2's kb_vec_virtual shape (id + embedding),
 * but the surrounding chunk/metadata tables will be defined in M4 with the
 * unified Resource model from § 5.2.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../util/logger.js";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";

export type DB = Database.Database;

const EMBEDDING_DIM = 768; // bge-m3 default; configurable in M4

let _db: DB | null = null;

function resolveDbPath(): string {
  // Anchor to the backend package root (apps/backend), NOT process.cwd().
  // `npm run dev` from the monorepo root has cwd=root; naïve resolve(cwd, ...)
  // would place the DB at apps/data/lia.db while a workspace-scoped script uses
  // apps/backend/data/lia.db — splitting data across two files. Anchoring here
  // keeps a single canonical location regardless of how the server is launched.
  // Here: apps/backend/src/db/ → ../../ = apps/backend
  const here = pathDirname(fileURLToPath(import.meta.url));
  const backendRoot = resolve(here, "../..");

  const fromEnv = process.env.LIA_DB_PATH;
  if (fromEnv) return resolve(backendRoot, fromEnv);
  // Default: <backend>/data/lia.db
  return resolve(backendRoot, "data/lia.db");
}

/**
 * Open (or reuse) the SQLite connection, load sqlite-vec, and ensure
 * kb_vec_virtual exists. Idempotent — safe to call from any entrypoint.
 */
export function getDb(): DB {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  logger.info({ dbPath }, "opening sqlite database");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  // Load sqlite-vec extension
  try {
    sqliteVec.load(db);
    // smoke-test: sqlite-vec exposes vec_version()
    const version = db
      .prepare("SELECT vec_version() AS v")
      .get() as { v: string } | undefined;
    logger.info({ vecVersion: version?.v }, "sqlite-vec loaded");
  } catch (err) {
    logger.error({ err }, "failed to load sqlite-vec extension");
    throw err;
  }

  // Ensure kb_vec_virtual exists (M0 deliverable per § 13.2).
  // Schema mirrors v2's pattern: vec0 with implicit rowid + embedding column.
  // Partition columns (source_id, source_type) land in M4 with the Resource model.
  // vec_f32() helper is exposed by sqlite-vec for inserting from JSON strings;
  // better-sqlite3 also accepts Float32Array directly (preferred).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec_virtual USING vec0(
      embedding FLOAT[${EMBEDDING_DIM}]
    );
  `);

  // All relational tables (schema_meta, settings, episodes, messages, …)
  // are created by drizzle-kit migrations — see src/db/push.ts and db/migrations/.
  // We only seed schema_meta here after migrations have run.
  // The seed is wrapped in try/catch so the very first run (before migrations)
  // doesn't crash — subsequent pushSchema() will create the table.

  _db = db;
  return db;
}

/** Test-only: inject a mock db. */
export function _setDbForTests(db: DB | null): void {
  _db = db;
}

/** Close the connection (used on graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info("sqlite database closed");
  }
}

export const EMBEDDING_DIMENSION = EMBEDDING_DIM;
