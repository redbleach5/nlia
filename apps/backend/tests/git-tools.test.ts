/**
 * Git ops + confirm flow tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitStatus, gitCommit, gitDiff, isGitRepo } from "../src/agent/git-ops.js";
import {
  beginGitConfirm,
  resolveGitConfirm,
  getPendingGitAction,
  cancelGitConfirm,
} from "../src/agent/git-confirm.js";
import { listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string) {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "lia@test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Lia Test"], { cwd: dir });
}

describe("git-ops", () => {
  let dir: string;
  let gitOk = true;

  beforeEach(async () => {
    // Keep temp repo inside workspace so sandbox tests can write + git init
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), "data", "git-test-"));
    try {
      await initRepo(dir);
      await writeFile(join(dir, "a.txt"), "one\n", "utf-8");
      await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
      gitOk = true;
    } catch {
      gitOk = false;
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects repo and status", async ({ skip }) => {
    if (!gitOk) skip();
    expect(await isGitRepo(dir)).toBe(true);
    await writeFile(join(dir, "a.txt"), "two\n", "utf-8");
    const status = await gitStatus(dir);
    expect(status.ok).toBe(true);
    expect(status.porcelain).toContain("a.txt");
  });

  it("commits changes", async ({ skip }) => {
    if (!gitOk) skip();
    await writeFile(join(dir, "b.txt"), "new\n", "utf-8");
    const result = await gitCommit(dir, "add b");
    expect(result.ok).toBe(true);
    expect(result.sha).toBeTruthy();
    const status = await gitStatus(dir);
    expect(status.porcelain.trim()).toBe("");
  });

  it("diff shows changes", async ({ skip }) => {
    if (!gitOk) skip();
    await writeFile(join(dir, "a.txt"), "changed\n", "utf-8");
    const diff = await gitDiff(dir);
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain("changed");
  });
});

describe("git-confirm", () => {
  afterEach(() => {
    cancelGitConfirm("t1");
  });

  it("resolves confirm with optional message edit", async () => {
    const { action, done } = beginGitConfirm("t1", {
      kind: "commit",
      message: "old",
      summary: "s",
      files: ["a.ts"],
    });
    expect(getPendingGitAction("t1")?.id).toBe(action.id);
    expect(resolveGitConfirm("t1", { decision: "confirm", message: "new msg" })).toBe(true);
    await expect(done).resolves.toEqual({ decision: "confirm", message: "new msg" });
  });

  it("resolves reject", async () => {
    const { done } = beginGitConfirm("t1", {
      kind: "push",
      summary: "push",
      remote: "origin",
      branch: "main",
    });
    resolveGitConfirm("t1", { decision: "reject" });
    await expect(done).resolves.toEqual({ decision: "reject" });
  });
});

describe("git tools registered", () => {
  it("registers git_* tools", () => {
    const names = listAllTools().map((t) => t.name);
    expect(names).toContain("git_status");
    expect(names).toContain("git_diff");
    expect(names).toContain("git_commit");
    expect(names).toContain("git_push");
  });
});
