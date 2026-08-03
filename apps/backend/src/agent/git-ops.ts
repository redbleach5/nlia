/**
 * Safe git operations via execFile (no shell). Used by agent git tools.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUT = 20_000;

async function git(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
      },
    });
    return {
      stdout: String(stdout).slice(0, MAX_OUT),
      stderr: String(stderr).slice(0, MAX_OUT),
      code: 0,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: String(err.stdout ?? "").slice(0, MAX_OUT),
      stderr: String(err.stderr ?? err.message ?? String(e)).slice(0, MAX_OUT),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, ".git"));
    return true;
  } catch {
    const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }
}

export async function gitStatus(cwd: string): Promise<{
  ok: boolean;
  branch: string | null;
  porcelain: string;
  shortStat: string;
  error?: string;
}> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, branch: null, porcelain: "", shortStat: "", error: "not a git repository" };
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const shortStat = await git(cwd, ["diff", "--stat", "HEAD"]);
  const unstaged = await git(cwd, ["diff", "--stat"]);
  return {
    ok: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    porcelain: porcelain.stdout,
    shortStat: [shortStat.stdout, unstaged.stdout].filter(Boolean).join("\n").trim(),
  };
}

export async function gitDiff(
  cwd: string,
  opts?: { staged?: boolean; path?: string },
): Promise<{ ok: boolean; diff: string; error?: string }> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, diff: "", error: "not a git repository" };
  }
  const args = ["diff"];
  if (opts?.staged) args.push("--cached");
  if (opts?.path) args.push("--", opts.path);
  const r = await git(cwd, args);
  // Also include untracked file names as a hint
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  let diff = r.stdout || "(no diff)";
  if (untracked.stdout.trim()) {
    diff += `\n\n# Untracked:\n${untracked.stdout.trim()}`;
  }
  return { ok: r.code === 0 || r.stdout.length > 0, diff: diff.slice(0, MAX_OUT) };
}

export async function gitCommit(
  cwd: string,
  message: string,
  opts?: { addAll?: boolean },
): Promise<{ ok: boolean; sha?: string; error?: string; stdout?: string }> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: "not a git repository" };
  }
  const msg = message.trim().slice(0, 500);
  if (!msg) return { ok: false, error: "empty commit message" };

  if (opts?.addAll !== false) {
    const add = await git(cwd, ["add", "-A"]);
    if (add.code !== 0) {
      return { ok: false, error: add.stderr || "git add failed" };
    }
  }

  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    return { ok: false, error: "nothing to commit (working tree clean)" };
  }

  const commit = await git(cwd, ["commit", "-m", msg]);
  if (commit.code !== 0) {
    return { ok: false, error: commit.stderr || commit.stdout || "git commit failed", stdout: commit.stdout };
  }

  const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  logger.info({ cwd, sha: sha.stdout.trim(), msg: msg.slice(0, 80) }, "git commit ok");
  return { ok: true, sha: sha.stdout.trim(), stdout: commit.stdout };
}

export async function gitPush(
  cwd: string,
  opts?: { remote?: string; branch?: string; setUpstream?: boolean },
): Promise<{ ok: boolean; error?: string; stdout?: string; stderr?: string }> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: "not a git repository" };
  }

  const remote = (opts?.remote ?? "origin").trim() || "origin";
  let branch = opts?.branch?.trim() || "";
  if (!branch) {
    const cur = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = cur.stdout.trim();
  }
  if (!branch || branch === "HEAD") {
    return { ok: false, error: "detached HEAD — specify branch" };
  }

  // Never force-push here. Force requires separate explicit path later.
  const args = ["push"];
  if (opts?.setUpstream !== false) {
    args.push("-u");
  }
  args.push(remote, branch);

  const r = await git(cwd, args, { timeoutMs: 120_000 });
  if (r.code !== 0) {
    logger.warn({ cwd, remote, branch, err: r.stderr }, "git push failed");
    return { ok: false, error: r.stderr || r.stdout || "git push failed", stdout: r.stdout, stderr: r.stderr };
  }
  logger.info({ cwd, remote, branch }, "git push ok");
  return { ok: true, stdout: r.stdout, stderr: r.stderr };
}

export function summarizePorcelain(porcelain: string, limit = 30): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(0, limit);
}
