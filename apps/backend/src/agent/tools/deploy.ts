/**
 * Deploy preset tools — list + run with UI confirm.
 */

import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import {
  loadDeployPresets,
  findPreset,
  runDeployPreset,
  isDeployAllowed,
} from "../deploy-ops.js";
import { beginUiConfirm, cancelUiConfirm } from "../ui-confirm.js";
import { updateTaskStatus, getTask } from "../service.js";

registerTool({
  name: "list_deploy_presets",
  description:
    "List deploy presets from .lia/deploy.json in fsScope. Read-only. " +
    "Requires LIA_ALLOW_DEPLOY=1 to actually run them later.",
  inputSchema: z.object({}),
  available: (_r, task) => task.fsScope !== null,
  execute: async (_input, ctx) => {
    const loaded = await loadDeployPresets(ctx.fsScope!);
    return {
      ...loaded,
      deployEnabled: isDeployAllowed(),
      hint: isDeployAllowed()
        ? "Call deploy with a preset name — user must Confirm in UI."
        : "Set LIA_ALLOW_DEPLOY=1 to enable running presets.",
    };
  },
});

registerTool({
  name: "deploy",
  description:
    "Run a named deploy preset from .lia/deploy.json. WAITS for user Confirm. " +
    "Command comes only from the preset file (model cannot invent shell). " +
    "Requires LIA_ALLOW_DEPLOY=1.",
  inputSchema: z.object({
    preset: z.string().min(1).max(100).describe("Preset name from list_deploy_presets"),
    summary: z.string().max(500).optional(),
  }),
  available: (_r, task) => task.fsScope !== null && isDeployAllowed(),
  execute: async (input, ctx) => {
    const { preset: presetName, summary } = input as { preset: string; summary?: string };
    const loaded = await loadDeployPresets(ctx.fsScope!);
    if (!loaded.ok) return loaded;
    const preset = findPreset(loaded.presets, presetName);
    if (!preset) {
      return {
        ok: false,
        error: `unknown preset "${presetName}"`,
        available: loaded.presets.map((p) => p.name),
      };
    }

    const { action, done } = beginUiConfirm(ctx.taskId, {
      kind: "deploy",
      summary: summary ?? preset.description ?? `Deploy «${preset.name}»`,
      preset: preset.name,
      command: preset.command,
    });

    ctx.emit({
      type: "deploy_propose",
      actionId: action.id,
      preset: preset.name,
      command: preset.command,
      summary: action.summary,
      ts: Date.now(),
    });

    updateTaskStatus(ctx.taskId, "waiting_input");

    try {
      const decision = await done;
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") updateTaskStatus(ctx.taskId, "executing");

      if (decision.decision === "reject") {
        ctx.emit({
          type: "deploy_rejected",
          actionId: action.id,
          preset: preset.name,
          ts: Date.now(),
        });
        return { ok: false, rejected: true };
      }

      const result = await runDeployPreset(ctx.fsScope!, preset);
      ctx.emit({
        type: "deploy_done",
        actionId: action.id,
        preset: preset.name,
        ok: result.ok,
        summary: result.ok
          ? `deploy ${preset.name} ok`
          : `deploy ${preset.name} failed: ${(result.error ?? "").slice(0, 200)}`,
        ts: Date.now(),
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cancelUiConfirm(ctx.taskId);
      const task = getTask(ctx.taskId);
      if (task?.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, msg === "cancelled" ? "cancelled" : "failed", { error: msg });
      }
      throw e;
    }
  },
});
