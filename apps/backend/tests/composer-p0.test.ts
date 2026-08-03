/**
 * Mentions + rules + multi-file apply/undo tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMentions } from "../src/agent/mentions.js";
import { loadWorkspaceRules } from "../src/agent/rules-loader.js";
import { buildMentionAndRulesContext } from "../src/agent/mention-context.js";
import {
  proposeOrApplyFileChange,
  applyAllPending,
  rejectAllPending,
  undoAllApplied,
  undoFileChange,
  getPendingFileOverlay,
  _clearFileChangesForTests,
} from "../src/agent/file-changes.js";
import { listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js";

describe("parseMentions", () => {
  it("parses @file and bare paths", () => {
    const m = parseMentions("Fix @file:src/a.ts and @folder:lib/ please");
    expect(m).toEqual([
      { kind: "file", path: "src/a.ts", lineStart: undefined, lineEnd: undefined },
      { kind: "folder", path: "lib" },
    ]);
  });

  it("parses line ranges", () => {
    const m = parseMentions("see @src/x.ts#L10-20");
    expect(m[0]).toMatchObject({ kind: "file", path: "src/x.ts", lineStart: 10, lineEnd: 20 });
  });
});

describe("rules + mention context", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lia-ctx-"));
    await writeFile(join(dir, "AGENTS.md"), "# Rules\nUse TypeScript.\n", "utf-8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads AGENTS.md", async () => {
    const rules = await loadWorkspaceRules(dir);
    expect(rules.source).toBe("AGENTS.md");
    expect(rules.text).toContain("TypeScript");
  });

  it("embeds mentioned file into context block", async () => {
    const ctx = await buildMentionAndRulesContext({
      goal: "Update @file:src/a.ts",
      fsScope: dir,
    });
    expect(ctx.mentionCount).toBe(1);
    expect(ctx.rulesSource).toBe("AGENTS.md");
    expect(ctx.block).toContain("export const a = 1");
    expect(ctx.block).toContain("Project rules");
  });
});

describe("multi-file apply/undo", () => {
  let dir: string;

  beforeEach(async () => {
    _clearFileChangesForTests();
    delete process.env.LIA_AUTO_APPLY_FILES;
    dir = await mkdtemp(join(tmpdir(), "lia-mf-"));
    await writeFile(join(dir, "a.ts"), "a1\n", "utf-8");
    await writeFile(join(dir, "b.ts"), "b1\n", "utf-8");
  });

  afterEach(async () => {
    _clearFileChangesForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("applyAllPending writes all files", async () => {
    await proposeOrApplyFileChange({
      taskId: "t",
      fsScope: dir,
      path: "a.ts",
      tool: "write_files",
      proposedContent: "a2\n",
    });
    await proposeOrApplyFileChange({
      taskId: "t",
      fsScope: dir,
      path: "b.ts",
      tool: "write_files",
      proposedContent: "b2\n",
    });
    expect(getPendingFileOverlay("t", "a.ts")).toBe("a2\n");

    const { applied, errors } = await applyAllPending("t", dir);
    expect(errors).toHaveLength(0);
    expect(applied).toHaveLength(2);
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("a2\n");
    expect(await readFile(join(dir, "b.ts"), "utf-8")).toBe("b2\n");
  });

  it("rejectAllPending leaves disk untouched", async () => {
    await proposeOrApplyFileChange({
      taskId: "t",
      fsScope: dir,
      path: "a.ts",
      tool: "write_file",
      proposedContent: "nope\n",
    });
    await rejectAllPending("t");
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("a1\n");
    expect(getPendingFileOverlay("t", "a.ts")).toBeUndefined();
  });

  it("undo restores previous content and can undo created files", async () => {
    const edit = await proposeOrApplyFileChange({
      taskId: "t",
      fsScope: dir,
      path: "a.ts",
      tool: "write_file",
      proposedContent: "a3\n",
    });
    await applyAllPending("t", dir);

    const create = await proposeOrApplyFileChange({
      taskId: "t",
      fsScope: dir,
      path: "c.ts",
      tool: "write_file",
      proposedContent: "new\n",
    });
    await applyAllPending("t", dir);
    expect(await readFile(join(dir, "c.ts"), "utf-8")).toBe("new\n");

    const undoCreate = await undoFileChange("t", create.id, dir);
    expect(undoCreate.ok).toBe(true);
    await expect(readFile(join(dir, "c.ts"), "utf-8")).rejects.toThrow();

    const { undone } = await undoAllApplied("t", dir);
    expect(undone.some((u) => u.id === edit.id)).toBe(true);
    expect(await readFile(join(dir, "a.ts"), "utf-8")).toBe("a1\n");
  });
});

describe("write_files tool registration", () => {
  it("registers write_files", () => {
    expect(listAllTools().map((t) => t.name)).toContain("write_files");
  });
});
