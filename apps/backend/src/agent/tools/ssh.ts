/**
 * SSH tools — list allowlisted hosts + run remote command with UI confirm.
 */

import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import {
  loadSshAllowlist,
  isHostAllowed,
  runSshCommand,
  isSshAllowed,
  validateSshCommand,
} from "../ssh-ops.js";
import { beginUiConfirm, cancelUiConfirm } from "../ui-confirm.js";
import { updateTaskStatus, getTask } from "../service.js";

registerTool({
  name: "list_ssh_hosts",
  description:
    "List SSH hosts from LIA_SSH_ALLOWLIST and/or .lia/ssh-allowlist.json. Read-only. " +
    "Requires LIA_ALLOW_SSH=1 to run commands.",
  inputSchema: z.object({}),
  available: (_r, task) => task.fsScope !== null,
  execute: async (_input, ctx) => {
    const list = await loadSshAllowlist(ctx.fsScope!);
    return {
      ...list,
      sshEnabled: isSshAllowed(),
      hint: isSshAllowed()
        ? "Call ssh_run with an allowlisted host — user must Confirm."
        : "Set LIA_ALLOW_SSH=1 and configure allowlist to enable.",
    };
  },
});

registerTool({
  name: "ssh_run",
  description:
    "Run a command on an allowlisted SSH host. WAITS for user Confirm. " +
    "Host must be in LIA_SSH_ALLOWLIST or .lia/ssh-allowlist.json. " +
    "Requires LIA_ALLOW_SSH=1. Uses BatchMode (key-based auth).",
  inputSchema: z.object({
    host: z.string().min(1).max(200).describe("user@host or host from allowlist"),
    command: z.string().min(1).max(2000).describe("Remote command to run"),
    summary: z.string().max(500).optional(),
  }),
  available: (_r, task) => task.fsScope !== null && isSshAllowed(),
  execute: async (input, ctx) => {
    const { host, command, summary } = input as {
      host: string;
      command: string;
      summary?: string;
    };

    const cmdErr = validateSshCommand(command);
    if (cmdErr) return { ok: false, error: cmdErr };

    const list = await loadSshAllowlist(ctx.fsScope!);
    if (list.hosts.length === 0) {
      return {
        ok: false,
        error: "SSH allowlist empty — set LIA_SSH_ALLOWLIST or .lia/ssh-allowlist.json",
      };
    }
    if (!isHostAllowed(list.hosts, host)) {
      return {
        ok: false,
        error: `host not in allowlist: ${host}`,
        allowlist: list.hosts,
      };
    }

    const { action, done } = beginUiConfirm(ctx.taskId, {
      kind: "ssh",
      summary: summary ?? `SSH ${host}: ${command.slice(0, 120)}`,
      host,
      sshCommand: command,
    });

    ctx.emit({
      type: "ssh_propose",
      actionId: action.id,
      host,
      command,
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
          type: "ssh_rejected",
          actionId: action.id,
          host,
          ts: Date.now(),
        });
        return { ok: false, rejected: true };
      }

      const result = await runSshCommand({ host, command });
      ctx.emit({
        type: "ssh_done",
        actionId: action.id,
        host,
        ok: result.ok,
        summary: result.ok
          ? `ssh ${host} ok`
          : `ssh ${host} failed: ${(result.error ?? "").slice(0, 200)}`,
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
