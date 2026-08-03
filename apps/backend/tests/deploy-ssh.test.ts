/**
 * Deploy presets + SSH allowlist tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loadDeployPresets,
  findPreset,
  isDeployAllowed,
} from "../src/agent/deploy-ops.js";
import {
  loadSshAllowlist,
  isHostAllowed,
  validateSshCommand,
  isSshAllowed,
} from "../src/agent/ssh-ops.js";
import { listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js";

describe("deploy presets", () => {
  let dir: string;
  const prevDeploy = process.env.LIA_ALLOW_DEPLOY;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), "data", "deploy-test-"));
    await mkdir(join(dir, ".lia"), { recursive: true });
    await writeFile(
      join(dir, ".lia", "deploy.json"),
      JSON.stringify({
        presets: [
          { name: "staging", command: "npm run deploy:staging", description: "stg" },
          { name: "bad", command: "rm -rf /; echo hi" }, // rejected by metachar filter
        ],
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    process.env.LIA_ALLOW_DEPLOY = prevDeploy;
    await rm(dir, { recursive: true, force: true });
  });

  it("loads safe presets and skips dangerous commands", async () => {
    const loaded = await loadDeployPresets(dir);
    expect(loaded.ok).toBe(true);
    expect(loaded.presets.map((p) => p.name)).toEqual(["staging"]);
    expect(findPreset(loaded.presets, "staging")?.command).toBe("npm run deploy:staging");
  });

  it("respects LIA_ALLOW_DEPLOY gate", () => {
    delete process.env.LIA_ALLOW_DEPLOY;
    expect(isDeployAllowed()).toBe(false);
    process.env.LIA_ALLOW_DEPLOY = "1";
    expect(isDeployAllowed()).toBe(true);
  });
});

describe("ssh allowlist", () => {
  let dir: string;
  const prevSsh = process.env.LIA_ALLOW_SSH;
  const prevList = process.env.LIA_SSH_ALLOWLIST;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), "data", "ssh-test-"));
    await mkdir(join(dir, ".lia"), { recursive: true });
    await writeFile(
      join(dir, ".lia", "ssh-allowlist.json"),
      JSON.stringify({ hosts: ["user@prod.example.com"] }),
      "utf-8",
    );
    delete process.env.LIA_SSH_ALLOWLIST;
  });

  afterEach(async () => {
    process.env.LIA_ALLOW_SSH = prevSsh;
    process.env.LIA_SSH_ALLOWLIST = prevList;
    await rm(dir, { recursive: true, force: true });
  });

  it("loads hosts from file and env", async () => {
    const fromFile = await loadSshAllowlist(dir);
    expect(fromFile.hosts).toContain("user@prod.example.com");

    process.env.LIA_SSH_ALLOWLIST = "deploy@staging.example.com";
    const merged = await loadSshAllowlist(dir);
    expect(merged.hosts).toContain("deploy@staging.example.com");
    expect(merged.hosts).toContain("user@prod.example.com");
  });

  it("checks host allowlist case-insensitively", () => {
    expect(isHostAllowed(["User@Prod.Example.com"], "user@prod.example.com")).toBe(true);
    expect(isHostAllowed(["a@b.com"], "other@b.com")).toBe(false);
  });

  it("validates remote commands", () => {
    expect(validateSshCommand("uptime")).toBeNull();
    expect(validateSshCommand("")).toBeTruthy();
    expect(validateSshCommand("echo\nhi")).toBeTruthy();
  });

  it("respects LIA_ALLOW_SSH gate", () => {
    delete process.env.LIA_ALLOW_SSH;
    expect(isSshAllowed()).toBe(false);
    process.env.LIA_ALLOW_SSH = "1";
    expect(isSshAllowed()).toBe(true);
  });
});

describe("deploy/ssh tools registered", () => {
  it("registers tools", () => {
    const names = listAllTools().map((t) => t.name);
    expect(names).toContain("list_deploy_presets");
    expect(names).toContain("deploy");
    expect(names).toContain("list_ssh_hosts");
    expect(names).toContain("ssh_run");
  });
});
