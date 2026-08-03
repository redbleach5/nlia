/**
 * Verify presets — post-write / pre-commit checks.
 *
 * Sources (merged):
 *   1. .lia/verify.json → { "commands": [{ "name", "command", "description?" }] }
 *   2. package.json scripts matching: typecheck, lint, test, check, build (as verify:build optional)
 *
 * No UI confirm — diagnostic only. Commands must come from config / known scripts.
 * Gate: always available when fsScope set (safer than free shell). Metachar filter applies.
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const MAX_OUT = 40_000;
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

export interface VerifyCommand {
  name: string;
  command: string;
  description?: string;
  source: "lia" | "package.json";
}

const PACKAGE_SCRIPT_NAMES = [
  "typecheck",
  "lint",
  "test",
  "check",
  "verify",
  "tsc",
] as const;

function safeJoin(fsScope: string, rel: string): string | null {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(fsScope, rel);
  const r = relative(fsScope, abs);
  if (r.startsWith("..")) return null;
  return abs;
}

function isSafeCommand(command: string): boolean {
  if (!command || command.length > 500) return false;
  if (/[;&|`$]/.test(command) || /\n/.test(command)) return false;
  return true;
}

async function loadLiaVerify(fsScope: string): Promise<VerifyCommand[]> {
  const path = safeJoin(fsScope, ".lia/verify.json");
  if (!path || !existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { commands?: unknown };
    if (!Array.isArray(parsed.commands)) return [];
    const out: VerifyCommand[] = [];
    for (const c of parsed.commands) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const command = typeof rec.command === "string" ? rec.command.trim() : "";
      if (!name || !isSafeCommand(command)) continue;
      out.push({
        name,
        command,
        description: typeof rec.description === "string" ? rec.description : undefined,
        source: "lia",
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function loadPackageScripts(fsScope: string): Promise<VerifyCommand[]> {
  const path = safeJoin(fsScope, "package.json");
  if (!path || !existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
    const out: VerifyCommand[] = [];
    for (const name of PACKAGE_SCRIPT_NAMES) {
      if (!(name in pkg.scripts)) continue;
      const command = `npm run ${name}`;
      if (!isSafeCommand(command)) continue;
      out.push({
        name,
        command,
        description: `package.json script «${name}»`,
        source: "package.json",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadVerifyCommands(fsScope: string): Promise<{
  ok: boolean;
  commands: VerifyCommand[];
  sources: string[];
}> {
  const lia = await loadLiaVerify(fsScope);
  const pkg = await loadPackageScripts(fsScope);
  const byName = new Map<string, VerifyCommand>();
  // package.json first, .lia overrides
  for (const c of pkg) byName.set(c.name.toLowerCase(), c);
  for (const c of lia) byName.set(c.name.toLowerCase(), c);

  const sources: string[] = [];
  if (lia.length) sources.push(".lia/verify.json");
  if (pkg.length) sources.push("package.json");

  return { ok: true, commands: [...byName.values()], sources };
}

export function findVerifyCommand(
  commands: VerifyCommand[],
  name: string,
): VerifyCommand | null {
  const key = name.trim().toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === key) ?? null;
}

/**
 * Default order for "run all": typecheck → lint → test → check → verify → rest
 */
export function defaultVerifyOrder(commands: VerifyCommand[]): VerifyCommand[] {
  const priority = ["typecheck", "tsc", "lint", "check", "test", "verify"];
  const ranked = [...commands].sort((a, b) => {
    const ia = priority.indexOf(a.name.toLowerCase());
    const ib = priority.indexOf(b.name.toLowerCase());
    const pa = ia === -1 ? 100 : ia;
    const pb = ib === -1 ? 100 : ib;
    return pa - pb || a.name.localeCompare(b.name);
  });
  return ranked;
}

export async function runVerifyCommand(
  fsScope: string,
  cmd: VerifyCommand,
): Promise<{
  ok: boolean;
  name: string;
  command: string;
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd.command], {
      cwd: fsScope,
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        TERM: "dumb",
        CI: "1",
        npm_config_yes: "true",
      },
    });
    logger.info({ name: cmd.name, ms: Date.now() - started }, "verify ok");
    return {
      ok: true,
      name: cmd.name,
      command: cmd.command,
      stdout: String(stdout).slice(0, MAX_OUT),
      stderr: String(stderr).slice(0, MAX_OUT),
      code: 0,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    logger.warn({ name: cmd.name, err: err.message }, "verify failed");
    return {
      ok: false,
      name: cmd.name,
      command: cmd.command,
      stdout: String(err.stdout ?? "").slice(0, MAX_OUT),
      stderr: String(err.stderr ?? err.message ?? String(e)).slice(0, MAX_OUT),
      code: typeof err.code === "number" ? err.code : 1,
      durationMs: Date.now() - started,
      error: err.stderr || err.message || "verify failed",
    };
  }
}
