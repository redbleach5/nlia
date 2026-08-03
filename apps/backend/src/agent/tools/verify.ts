/**
 * Verify tools — list + run checks (no UI confirm; diagnostic loop).
 */

import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import {
  loadVerifyCommands,
  findVerifyCommand,
  defaultVerifyOrder,
  runVerifyCommand,
} from "../verify-ops.js";

registerTool({
  name: "list_verify",
  description:
    "List available verify commands from .lia/verify.json and package.json " +
    "(typecheck/lint/test/check/verify). Read-only.",
  inputSchema: z.object({}),
  available: (_r, task) => task.fsScope !== null,
  execute: async (_input, ctx) => {
    const loaded = await loadVerifyCommands(ctx.fsScope!);
    return {
      ...loaded,
      hint:
        loaded.commands.length === 0
          ? "No verify commands found — add .lia/verify.json or npm scripts typecheck/lint/test."
          : "Call run_verify before git_commit. On failure, fix with write_files and re-verify.",
    };
  },
});

registerTool({
  name: "run_verify",
  description:
    "Run project verify checks (typecheck/lint/test). No UI confirm. " +
    "Pass name for one command, or omit to run the default suite in order. " +
    "Use after Apply / before git_commit. On failure: fix code and re-run.",
  inputSchema: z.object({
    name: z
      .string()
      .max(100)
      .optional()
      .describe("Single verify command name; omit to run default suite"),
  }),
  available: (_r, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { name } = input as { name?: string };
    const loaded = await loadVerifyCommands(ctx.fsScope!);
    if (loaded.commands.length === 0) {
      return {
        ok: false,
        error: "no verify commands — add .lia/verify.json or package.json scripts",
      };
    }

    const toRun = name
      ? (() => {
          const one = findVerifyCommand(loaded.commands, name);
          return one ? [one] : null;
        })()
      : defaultVerifyOrder(loaded.commands);

    if (!toRun) {
      return {
        ok: false,
        error: `unknown verify command "${name}"`,
        available: loaded.commands.map((c) => c.name),
      };
    }

    ctx.emit({
      type: "verify_start",
      names: toRun.map((c) => c.name),
      ts: Date.now(),
    });

    const results = [];
    for (const cmd of toRun) {
      const result = await runVerifyCommand(ctx.fsScope!, cmd);
      results.push(result);
      if (!result.ok) {
        // Stop on first failure — agent should fix then re-run
        ctx.emit({
          type: "verify_done",
          ok: false,
          failed: result.name,
          summary: `${result.name} failed (exit ${result.code})`,
          results: results.map((r) => ({
            name: r.name,
            ok: r.ok,
            code: r.code,
            durationMs: r.durationMs,
          })),
          ts: Date.now(),
        });
        return {
          ok: false,
          failed: result.name,
          results,
          stdout: result.stdout.slice(-8000),
          stderr: result.stderr.slice(-8000),
          hint: "Fix the errors with write_files/apply_patch, then run_verify again before git_commit.",
        };
      }
    }

    ctx.emit({
      type: "verify_done",
      ok: true,
      failed: null,
      summary: `all passed: ${toRun.map((c) => c.name).join(", ")}`,
      results: results.map((r) => ({
        name: r.name,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
      })),
      ts: Date.now(),
    });

    return {
      ok: true,
      results: results.map((r) => ({
        name: r.name,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
        stdoutTail: r.stdout.slice(-2000),
        stderrTail: r.stderr.slice(-1000),
      })),
      hint: "Verify passed — safe to propose git_commit (after user Apply if files still pending).",
    };
  },
});
