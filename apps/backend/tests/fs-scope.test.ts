/**
 * fsScope validation tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import { mount } from "../src/workspace/service.js";
import { validateFsScope } from "../src/agent/fs-scope.js";

describe("validateFsScope", () => {
  let episodeId: string;
  let mountDir: string;
  const prevRoot = process.env.LIA_WORKSPACE_ROOT;

  beforeAll(async () => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "fsScope test" });
    episodeId = ep.id;
    mountDir = mkdtempSync(join(tmpdir(), "lia-fsscope-"));
    await mount(episodeId, { kind: "folder", path: mountDir, name: "tmp" });
  });

  afterAll(() => {
    closeDb();
    if (prevRoot === undefined) delete process.env.LIA_WORKSPACE_ROOT;
    else process.env.LIA_WORKSPACE_ROOT = prevRoot;
    try {
      rmSync(mountDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    delete process.env.LIA_WORKSPACE_ROOT;
  });

  it("allows empty fsScope", () => {
    const r = validateFsScope(episodeId, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBeNull();
  });

  it("rejects filesystem root", () => {
    const r = validateFsScope(episodeId, "/");
    expect(r.ok).toBe(false);
  });

  it("allows path under episode mount when no workspace root", () => {
    const r = validateFsScope(episodeId, mountDir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBeTruthy();
  });

  it("rejects path outside mounts when no workspace root", () => {
    const r = validateFsScope(episodeId, tmpdir());
    // tmpdir itself may be parent of mountDir — use a clearly unrelated path
    const r2 = validateFsScope(episodeId, "/var");
    expect(r2.ok).toBe(false);
    void r;
  });

  it("POST /api/agent rejects fsScope outside mounts", async () => {
    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episodeId,
        goal: "should fail",
        fsScope: "/var",
        autoStart: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/fs_scope/);
  });

  it("POST /api/agent accepts fsScope under mount", async () => {
    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episodeId,
        goal: "scoped task",
        fsScope: mountDir,
        autoStart: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.fsScope).toBeTruthy();
  });
});
