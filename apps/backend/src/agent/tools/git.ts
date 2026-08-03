/**
 * Agent git tools — status/diff (immediate) + commit/push (UI confirm required).
 */

import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import {
  gitStatus,
  gitDiff,
  gitCommit,
  gitPush,
  summarizePorcelain,
} from "../git-ops.js";
import { beginGitConfirm, cancelGitConfirm } from "../git-confirm.js";
import { updateTaskStatus, getTask } from "../service.js";

registerTool({
  name: "git_status",
  description:
    "Show git status in fsScope (branch + changed files). Read-only, no confirmation.",
  inputSchema: z.object({}),
  available: (_r, task) => task.fsScope !== null,
  execute: async (_input, ctx) => {
    const status = await gitStatus(ctx.fsScope!);
    if (!status.ok) return status;
    return {
      ok: true,
      branch: status.branch,
      files: summarizePorcelain(status.porcelain),
      porcelain: status.porcelain,
      shortStat: status.shortStat,
    };
  },
});

registerTool({
  name: "git_diff",
  description:
    "Show git diff in fsScope (working tree). Optional path filter. Read-only.",
  inputSchema: z.object({
    path: z.string().optional(),
    staged: z.boolean().optional(),
  }),
  available: (_r, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { path, staged } = input as { path?: string; staged?: boolean };
    return gitDiff(ctx.fsScope!, { path, staged });
  },
});

registerTool({
  name: "git_commit",
  description:
    "Propose a git commit (add -A + commit). WAITS for user Confirm in the UI before running. " +
    "Prefer run_verify first (must be green). Use after file Apply when the user wants changes saved. " +
    "Provide a clear commit message. Optionally mention 1–3 simpler/efficiency ideas in text.",
  inputSchema: z.object({
    message: z.string().min(1).max(500).describe("Commit message"),
    summary: z
      .string()
      .max(1000)
      .optional()
      .describe("Short human summary of what is being committed"),
  }),
  available: (_r, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { message, summary } = input as { message: string; summary?: string };
    const status = await gitStatus(ctx.fsScope!);
    if (!status.ok) return status;
    const files = summarizePorcelain(status.porcelain);
    if (files.length === 0) {
      return { ok: false, error: "nothing to commit (clean working tree)" };
    }

    const { action, done } = beginGitConfirm(ctx.taskId, {
      kind: "commit",
      message,
      summary: summary ?? status.shortStat.slice(0, 400),
      files,
      branch: status.branch ?? undefined,
    });

    ctx.emit({
      type: "git_propose_commit",
      actionId: action.id,
      message,
      summary: action.summary,
      files,
      branch: status.branch,
      ts: Date.now(),
    });

    updateTaskStatus(ctx.taskId, "waiting_input");

    try {
      const decision = await done;
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, "executing");
      }

      if (decision.decision === "reject") {
        ctx.emit({
          type: "git_rejected",
          actionId: action.id,
          kind: "commit",
          ts: Date.now(),
        });
        return { ok: false, rejected: true, message: "user rejected commit" };
      }

      const finalMessage = (decision.message?.trim() || message).slice(0, 500);
      const result = await gitCommit(ctx.fsScope!, finalMessage, { addAll: true });
      if (result.ok) {
        ctx.emit({
          type: "git_committed",
          actionId: action.id,
          sha: result.sha ?? "",
          message: finalMessage,
          ts: Date.now(),
        });
      }
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cancelGitConfirm(ctx.taskId);
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, msg === "cancelled" ? "cancelled" : "failed", {
          error: msg,
        });
      }
      throw e;
    }
  },
});

registerTool({
  name: "git_push",
  description:
    "Propose git push to remote. WAITS for user Confirm in the UI. " +
    "Never force-pushes. Default remote=origin, current branch, sets upstream.",
  inputSchema: z.object({
    remote: z.string().max(100).optional(),
    branch: z.string().max(200).optional(),
    summary: z.string().max(500).optional(),
  }),
  available: (_r, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { remote, branch, summary } = input as {
      remote?: string;
      branch?: string;
      summary?: string;
    };
    const status = await gitStatus(ctx.fsScope!);
    if (!status.ok) return status;

    const remoteName = remote ?? "origin";
    const branchName = branch ?? status.branch ?? undefined;

    const { action, done } = beginGitConfirm(ctx.taskId, {
      kind: "push",
      remote: remoteName,
      branch: branchName,
      summary: summary ?? `Push ${branchName ?? "HEAD"} → ${remoteName}`,
    });

    ctx.emit({
      type: "git_propose_push",
      actionId: action.id,
      remote: remoteName,
      branch: branchName ?? null,
      summary: action.summary,
      ts: Date.now(),
    });

    updateTaskStatus(ctx.taskId, "waiting_input");

    try {
      const decision = await done;
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, "executing");
      }

      if (decision.decision === "reject") {
        ctx.emit({
          type: "git_rejected",
          actionId: action.id,
          kind: "push",
          ts: Date.now(),
        });
        return { ok: false, rejected: true, message: "user rejected push" };
      }

      const result = await gitPush(ctx.fsScope!, {
        remote: remoteName,
        branch: branchName,
        setUpstream: true,
      });
      if (result.ok) {
        ctx.emit({
          type: "git_pushed",
          actionId: action.id,
          remote: remoteName,
          branch: branchName ?? "",
          ts: Date.now(),
        });
      }
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cancelGitConfirm(ctx.taskId);
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, msg === "cancelled" ? "cancelled" : "failed", {
          error: msg,
        });
      }
      throw e;
    }
  },
});
