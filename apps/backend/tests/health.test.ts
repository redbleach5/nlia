/**
 * Smoke test: /api/health returns 200 with all M0 deliverables healthy.
 *
 * Boots the Hono app in-process (no port binding), calls app.request().
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import type { HealthResponse } from "@lia/shared";

describe("GET /api/health", () => {
  beforeAll(() => {
    // Ensure DB is initialised + migrations applied + schema_meta seeded
    getDb();
    pushSchema();
  });

  afterAll(() => {
    closeDb();
  });

  it("returns 200 with status ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.runtime).toMatch(/^(node|bun)$/);
    expect(body.sqliteVec).toBe(true);
    expect(body.kbVecTable).toBe(true);
    expect(body.dbOk).toBe(true);
    expect(body.vecVersion).toBeTruthy();
    expect(body.schemaVersion).toBe("m1");
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns 404 for unknown /api routes", async () => {
    const res = await app.request("/api/no-such-route");
    expect(res.status).toBe(404);
  });
});
