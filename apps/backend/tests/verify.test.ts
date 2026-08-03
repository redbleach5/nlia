/**
 * Verify presets + run_verify tool registration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loadVerifyCommands,
  findVerifyCommand,
  defaultVerifyOrder,
  runVerifyCommand,
} from "../src/agent/verify-ops.js";
import { listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js";

describe("verify-ops", () => {
  let dir: string;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), "data", "verify-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads package.json scripts and .lia/verify.json (lia overrides)", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "echo test", lint: "echo lint", typecheck: "echo tc" },
      }),
      "utf-8",
    );
    await mkdir(join(dir, ".lia"), { recursive: true });
    await writeFile(
      join(dir, ".lia", "verify.json"),
      JSON.stringify({
        commands: [{ name: "typecheck", command: "echo custom-tc" }],
      }),
      "utf-8",
    );

    const loaded = await loadVerifyCommands(dir);
    expect(loaded.commands.map((c) => c.name).sort()).toEqual(["lint", "test", "typecheck"]);
    const tc = findVerifyCommand(loaded.commands, "typecheck");
    expect(tc?.command).toBe("echo custom-tc");
    expect(tc?.source).toBe("lia");
  });

  it("orders defaults typecheck → lint → test", async () => {
    const ordered = defaultVerifyOrder([
      { name: "test", command: "npm run test", source: "package.json" },
      { name: "typecheck", command: "npm run typecheck", source: "package.json" },
      { name: "lint", command: "npm run lint", source: "package.json" },
    ]);
    expect(ordered.map((c) => c.name)).toEqual(["typecheck", "lint", "test"]);
  });

  it("runs a safe verify command", async () => {
    const result = await runVerifyCommand(dir, {
      name: "ok",
      command: "echo hello-verify",
      source: "lia",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello-verify");
  });

  it("rejects dangerous commands from lia file", async () => {
    await mkdir(join(dir, ".lia"), { recursive: true });
    await writeFile(
      join(dir, ".lia", "verify.json"),
      JSON.stringify({
        commands: [{ name: "bad", command: "echo hi; rm -rf /" }],
      }),
      "utf-8",
    );
    const loaded = await loadVerifyCommands(dir);
    expect(loaded.commands.find((c) => c.name === "bad")).toBeUndefined();
  });
});

describe("verify tools registered", () => {
  it("registers list_verify and run_verify", () => {
    const names = listAllTools().map((t) => t.name);
    expect(names).toContain("list_verify");
    expect(names).toContain("run_verify");
  });
});
