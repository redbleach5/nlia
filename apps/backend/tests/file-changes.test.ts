/**
 * Tests for wait-input + file-changes propose/apply/reject.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  waitForUserAnswer,
  resolveWaiting,
  cancelWaiting,
  isWaiting,
} from "../src/agent/wait-input.js";
import {
  proposeOrApplyFileChange,
  applyFileChange,
  rejectFileChange,
  getPendingFileOverlay,
  _clearFileChangesForTests,
} from "../src/agent/file-changes.js";
import { listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js";

describe("wait-input", () => {
  afterEach(() => {
    cancelWaiting("t1");
  });

  it("resolves when resolveWaiting is called", async () => {
    const p = waitForUserAnswer("t1", "Q?");
    expect(isWaiting("t1")).toBe(true);
    expect(resolveWaiting("t1", "yes")).toBe(true);
    await expect(p).resolves.toBe("yes");
    expect(isWaiting("t1")).toBe(false);
  });

  it("rejects on cancelWaiting", async () => {
    const p = waitForUserAnswer("t1", "Q?");
    cancelWaiting("t1", "cancelled");
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("file-changes", () => {
  let dir: string;

  beforeEach(async () => {
    _clearFileChangesForTests();
    delete process.env.LIA_AUTO_APPLY_FILES;
    dir = await mkdtemp(join(tmpdir(), "lia-fc-"));
    await writeFile(join(dir, "a.ts"), "const x = 1;\n", "utf-8");
  });

  afterEach(async () => {
    _clearFileChangesForTests();
    delete process.env.LIA_AUTO_APPLY_FILES;
    await rm(dir, { recursive: true, force: true });
  });

  it("proposes without writing to disk", async () => {
    const record = await proposeOrApplyFileChange({
      taskId: "task1",
      fsScope: dir,
      path: "a.ts",
      tool: "write_file",
      proposedContent: "const x = 2;\n",
    });
    expect(record.applied).toBe(false);
    expect(record.status).toBe("pending");
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("const x = 1;\n");
    expect(getPendingFileOverlay("task1", "a.ts")).toBe("const x = 2;\n");
  });

  it("applies pending change to disk", async () => {
    const record = await proposeOrApplyFileChange({
      taskId: "task1",
      fsScope: dir,
      path: "a.ts",
      tool: "apply_patch",
      proposedContent: "const x = 3;\n",
    });
    const result = await applyFileChange("task1", record.id, dir);
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("const x = 3;\n");
    expect(getPendingFileOverlay("task1", "a.ts")).toBeUndefined();
  });

  it("rejects pending change without writing", async () => {
    const record = await proposeOrApplyFileChange({
      taskId: "task1",
      fsScope: dir,
      path: "a.ts",
      tool: "write_file",
      proposedContent: "nope\n",
    });
    const result = await rejectFileChange("task1", record.id);
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("const x = 1;\n");
  });

  it("auto-applies when LIA_AUTO_APPLY_FILES=1", async () => {
    process.env.LIA_AUTO_APPLY_FILES = "1";
    const record = await proposeOrApplyFileChange({
      taskId: "task1",
      fsScope: dir,
      path: "a.ts",
      tool: "write_file",
      proposedContent: "auto\n",
    });
    expect(record.applied).toBe(true);
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("auto\n");
  });
});

describe("tool registry", () => {
  it("registers apply_patch", () => {
    const names = listAllTools().map((t) => t.name);
    expect(names).toContain("apply_patch");
  });
});
