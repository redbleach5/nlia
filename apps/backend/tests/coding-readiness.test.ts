/**
 * Coding readiness endpoint for UI checklist.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { agentRoute } from "../src/routes/agent.js";

describe("GET /coding-readiness", () => {
  let dir: string;
  const app = new Hono().route("/api/agent", agentRoute);

  beforeEach(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), "data", "readiness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports empty verify without path", async () => {
    const res = await app.request("/api/agent/coding-readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verify.ready).toBe(false);
    expect(body.flow).toContain("Apply");
  });

  it("detects verify scripts from package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc -p .", test: "vitest" } }),
      "utf-8",
    );
    const res = await app.request(
      `/api/agent/coding-readiness?path=${encodeURIComponent(dir)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verify.ready).toBe(true);
    expect(body.verify.commands).toEqual(expect.arrayContaining(["typecheck", "test"]));
  });
});
