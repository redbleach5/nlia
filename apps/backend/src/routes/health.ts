/**
 * GET /api/health — M0 acceptance endpoint.
 *
 * Returns runtime info used to verify the stack works:
 *   - status: "ok" | "degraded"
 *   - runtime: "node" | "bun"
 *   - nodeVersion: process.versions.node
 *   - sqliteVec: boolean — was sqlite-vec extension loaded?
 *   - vecVersion: string | null — sqlite-vec version
 *   - dbPath: resolved db file path
 *   - schemaVersion: from schema_meta
 *   - kbVecTable: boolean — does kb_vec_virtual exist?
 *   - uptimeMs: process.uptime() * 1000
 */

import { Hono } from "hono";
import { getDb } from "../db/client.js";
import { logger } from "../util/logger.js";
import { env } from "../util/env.js";
import type { HealthResponse } from "@lia/shared";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  let sqliteVec = false;
  let vecVersion: string | null = null;
  let schemaVersion: string | null = null;
  let kbVecTable = false;
  let dbOk = false;

  try {
    const db = getDb();
    dbOk = true;

    // Verify sqlite-vec is loaded
    try {
      const row = db.prepare("SELECT vec_version() AS v").get() as
        | { v: string }
        | undefined;
      if (row?.v) {
        sqliteVec = true;
        vecVersion = row.v;
      }
    } catch {
      // extension not loaded — degraded
    }

    // Verify kb_vec_virtual exists
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='kb_vec_virtual'",
        )
        .get() as { name: string } | undefined;
      kbVecTable = !!row?.name;
    } catch {
      // ignore
    }

    // Read schema version
    try {
      const row = db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = row?.value ?? null;
    } catch {
      // ignore
    }
  } catch (err) {
    logger.error({ err }, "health check: db probe failed");
  }

  const status: HealthResponse["status"] =
    dbOk && sqliteVec && kbVecTable ? "ok" : "degraded";

  // Detect Bun runtime without depending on @types/bun (which would force the
  // dep on every consumer). Cast through unknown to keep TS happy.
  const g = globalThis as unknown as { Bun?: { version: string } };
  const bunVersion = g.Bun?.version ?? null;

  const body: HealthResponse = {
    status,
    runtime: env.runtime,
    nodeVersion: process.versions.node,
    bunVersion,
    sqliteVec,
    vecVersion,
    dbOk,
    kbVecTable,
    schemaVersion,
    uptimeMs: Math.round(process.uptime() * 1000),
    timestamp: new Date().toISOString(),
  };

  return c.json(body, status === "ok" ? 200 : 503);
});
