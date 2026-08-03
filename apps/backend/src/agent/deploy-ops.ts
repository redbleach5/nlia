/**
 * Deploy presets — load from .lia/deploy.json under fsScope.
 *
 * Example:
 * {
 *   "presets": [
 *     { "name": "staging", "command": "npm run deploy:staging", "description": "Fly staging" },
 *     { "name": "prod", "command": "npm run deploy", "description": "Production" }
 *   ]
 * }
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const MAX_OUT = 30_000;
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

export interface DeployPreset {
  name: string;
  command: string;
  description?: string;
  /** Relative cwd under fsScope (default ".") */
  cwd?: string;
}

export function isDeployAllowed(): boolean {
  return (
    process.env.LIA_ALLOW_DEPLOY === "1" || process.env.LIA_ALLOW_DEPLOY === "true"
  );
}

function safeJoin(fsScope: string, rel: string): string | null {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(fsScope, rel);
  const r = relative(fsScope, abs);
  if (r.startsWith("..")) return null;
  return abs;
}

export async function loadDeployPresets(fsScope: string): Promise<{
  ok: boolean;
  presets: DeployPreset[];
  source: string | null;
  error?: string;
}> {
  const path = safeJoin(fsScope, ".lia/deploy.json");
  if (!path || !existsSync(path)) {
    return {
      ok: true,
      presets: [],
      source: null,
      error: "no .lia/deploy.json — create presets to enable deploy",
    };
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { presets?: unknown };
    if (!Array.isArray(parsed.presets)) {
      return { ok: false, presets: [], source: ".lia/deploy.json", error: "presets must be an array" };
    }
    const presets: DeployPreset[] = [];
    for (const p of parsed.presets) {
      if (!p || typeof p !== "object") continue;
      const rec = p as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const command = typeof rec.command === "string" ? rec.command.trim() : "";
      if (!name || !command) continue;
      if (command.length > 500) continue;
      // Block obvious shell metacharacters for safety even in presets
      if (/[;&|`$]/.test(command) || /\n/.test(command)) continue;
      presets.push({
        name,
        command,
        description: typeof rec.description === "string" ? rec.description : undefined,
        cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
      });
    }
    return { ok: true, presets, source: ".lia/deploy.json" };
  } catch (e) {
    return {
      ok: false,
      presets: [],
      source: ".lia/deploy.json",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function findPreset(
  presets: DeployPreset[],
  name: string,
): DeployPreset | null {
  const key = name.trim().toLowerCase();
  return presets.find((p) => p.name.toLowerCase() === key) ?? null;
}

/**
 * Run a deploy preset command via /bin/sh -c in scoped cwd.
 * Command must come from the loaded preset (never free-form from the model).
 */
export async function runDeployPreset(
  fsScope: string,
  preset: DeployPreset,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number; error?: string }> {
  if (!isDeployAllowed()) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      code: 1,
      error: "deploy disabled (set LIA_ALLOW_DEPLOY=1)",
    };
  }

  const cwdRel = preset.cwd?.trim() || ".";
  const cwd = safeJoin(fsScope, cwdRel);
  if (!cwd) {
    return { ok: false, stdout: "", stderr: "", code: 1, error: "preset cwd escapes fsScope" };
  }

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", preset.command], {
      cwd,
      timeout: DEPLOY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        TERM: "dumb",
        CI: process.env.CI,
      },
    });
    logger.info({ preset: preset.name, cwd }, "deploy preset ok");
    return {
      ok: true,
      stdout: String(stdout).slice(0, MAX_OUT),
      stderr: String(stderr).slice(0, MAX_OUT),
      code: 0,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    logger.warn({ preset: preset.name, err: err.message }, "deploy preset failed");
    return {
      ok: false,
      stdout: String(err.stdout ?? "").slice(0, MAX_OUT),
      stderr: String(err.stderr ?? err.message ?? String(e)).slice(0, MAX_OUT),
      code: typeof err.code === "number" ? err.code : 1,
      error: err.stderr || err.message || "deploy failed",
    };
  }
}
