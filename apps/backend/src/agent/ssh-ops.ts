/**
 * SSH allowlist + remote command runner.
 *
 * Allowlist sources (first match wins content merge):
 *   1. LIA_SSH_ALLOWLIST=user@host1,host2
 *   2. .lia/ssh-allowlist.json → { "hosts": ["user@prod", "staging"] }
 *
 * Requires LIA_ALLOW_SSH=1. Always BatchMode (no password prompt).
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const MAX_OUT = 30_000;
const SSH_TIMEOUT_MS = 5 * 60 * 1000;

export function isSshAllowed(): boolean {
  return process.env.LIA_ALLOW_SSH === "1" || process.env.LIA_ALLOW_SSH === "true";
}

function normalizeHost(h: string): string {
  return h.trim().toLowerCase();
}

function parseEnvAllowlist(): string[] {
  const raw = process.env.LIA_SSH_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadFileAllowlist(fsScope: string): Promise<string[]> {
  const abs = isAbsolute(".lia/ssh-allowlist.json")
    ? resolve(".lia/ssh-allowlist.json")
    : resolve(fsScope, ".lia/ssh-allowlist.json");
  const rel = relative(fsScope, abs);
  if (rel.startsWith("..") || !existsSync(abs)) return [];
  try {
    const raw = await readFile(abs, "utf-8");
    const parsed = JSON.parse(raw) as { hosts?: unknown };
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0);
  } catch {
    return [];
  }
}

export async function loadSshAllowlist(fsScope: string): Promise<{
  hosts: string[];
  sources: string[];
}> {
  const sources: string[] = [];
  const hosts = new Set<string>();
  const fromEnv = parseEnvAllowlist();
  if (fromEnv.length) {
    sources.push("LIA_SSH_ALLOWLIST");
    for (const h of fromEnv) hosts.add(h);
  }
  const fromFile = await loadFileAllowlist(fsScope);
  if (fromFile.length) {
    sources.push(".lia/ssh-allowlist.json");
    for (const h of fromFile) hosts.add(h);
  }
  return { hosts: [...hosts], sources };
}

export function isHostAllowed(allowlist: string[], host: string): boolean {
  const target = normalizeHost(host);
  return allowlist.some((h) => normalizeHost(h) === target);
}

/** Reject empty / metacharacter-heavy remote commands. */
export function validateSshCommand(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return "empty command";
  if (cmd.length > 2000) return "command too long";
  if (/[\n\r]/.test(cmd)) return "newlines not allowed";
  return null;
}

export async function runSshCommand(opts: {
  host: string;
  command: string;
  identityFile?: string;
}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; error?: string }> {
  if (!isSshAllowed()) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      code: 1,
      error: "ssh disabled (set LIA_ALLOW_SSH=1)",
    };
  }

  const cmdErr = validateSshCommand(opts.command);
  if (cmdErr) {
    return { ok: false, stdout: "", stderr: "", code: 1, error: cmdErr };
  }

  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=20",
  ];
  if (opts.identityFile) {
    args.push("-i", opts.identityFile);
  }
  args.push(opts.host, opts.command);

  try {
    const { stdout, stderr } = await execFileAsync("ssh", args, {
      timeout: SSH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        TERM: "dumb",
      },
    });
    logger.info({ host: opts.host }, "ssh_run ok");
    return {
      ok: true,
      stdout: String(stdout).slice(0, MAX_OUT),
      stderr: String(stderr).slice(0, MAX_OUT),
      code: 0,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    logger.warn({ host: opts.host, err: err.message }, "ssh_run failed");
    return {
      ok: false,
      stdout: String(err.stdout ?? "").slice(0, MAX_OUT),
      stderr: String(err.stderr ?? err.message ?? String(e)).slice(0, MAX_OUT),
      code: typeof err.code === "number" ? err.code : 1,
      error: err.stderr || err.message || "ssh failed",
    };
  }
}
