/**
 * Agent routes — create, list, get, cancel, stream, input, file apply/reject.
 *
 * POST   /api/agent                    — create + auto-start task
 * GET    /api/agent                    — list tasks (?episodeId=)
 * GET    /api/agent/:id                — get single task
 * POST   /api/agent/:id/cancel         — cancel running task
 * POST   /api/agent/:id/input          — answer ask_user (waiting_input)
 * GET    /api/agent/:id/file-changes   — list proposed/applied file edits
 * POST   /api/agent/:id/file-apply     — apply a pending file change
 * POST   /api/agent/:id/file-reject    — reject a pending file change
 * GET    /api/agent/:id/stream         — SSE stream of events (live + replay)
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import {
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  appendEvent,
  sweepStaleTasks,
} from "../agent/service.js";
import { runAgentTask } from "../agent/orchestrator.js";
import { validateFsScope } from "../agent/fs-scope.js";
import { isWaiting, resolveWaiting, cancelWaiting } from "../agent/wait-input.js";
import {
  getPendingUiAction,
  isUiWaiting,
  resolveUiConfirm,
  cancelUiConfirm,
} from "../agent/ui-confirm.js";
import {
  listTaskFileChanges,
  applyFileChange,
  rejectFileChange,
  undoFileChange,
  applyAllPending,
  rejectAllPending,
  undoAllApplied,
} from "../agent/file-changes.js";
import { list as listResources } from "../workspace/service.js";
import { getEpisode } from "../services/episodes.js";
import { loadVerifyCommands } from "../agent/verify-ops.js";
import { loadDeployPresets, isDeployAllowed } from "../agent/deploy-ops.js";
import { loadSshAllowlist, isSshAllowed } from "../agent/ssh-ops.js";
import { logger } from "../util/logger.js";
import type { AgentEvent, CreateAgentTaskRequest, AgentTask, ResourceConfig } from "@lia/shared";

export const agentRoute = new Hono();

const createSchema = z.object({
  episodeId: z.string().min(1).max(100),
  goal: z.string().trim().min(1).max(10_000),
  template: z.enum(["general", "researcher", "coder"]).optional(),
  fsScope: z.string().max(2000).optional(),
  toolsWhitelist: z.array(z.string()).optional(),
  maxSteps: z.number().min(1).max(100).optional(),
  maxDurationSec: z.number().min(60).max(7200).optional(),
  autoStart: z.boolean().optional(),
});

const inputSchema = z.object({
  answer: z.string().trim().min(1).max(10_000),
});

const fileChangeSchema = z.object({
  changeId: z.string().min(1).max(100),
});

/** Prefer explicit fsScope; else first mounted folder/codebase on the episode. */
function resolveDefaultFsScope(episodeId: string, requested?: string | null): string | null | undefined {
  if (requested && requested.trim()) return requested.trim();
  const resources = listResources(episodeId);
  for (const r of resources) {
    if (r.kind !== "folder" && r.kind !== "codebase") continue;
    const cfg = r.config as ResourceConfig;
    const p = cfg.folderPath ?? cfg.projectPath;
    if (p) return p;
  }
  return requested;
}

// GET / — list tasks
agentRoute.get("/", (c) => {
  sweepStaleTasks();

  const episodeId = c.req.query("episodeId");
  const tasks = listTasks(episodeId, 50);
  return c.json({ tasks: tasks satisfies AgentTask[] });
});

/**
 * GET /coding-readiness?path= — UI checklist for Code/Agent modes.
 * Reports verify / deploy / ssh setup for a mounted project path.
 * Registered before /:id so "coding-readiness" is not treated as a task id.
 */
agentRoute.get("/coding-readiness", async (c) => {
  const path = (c.req.query("path") ?? "").trim();
  if (!path) {
    return c.json({
      path: null,
      verify: { ready: false, commands: [] as string[], sources: [] as string[] },
      deploy: {
        ready: false,
        presets: [] as string[],
        allowed: isDeployAllowed(),
        hint: "Смонтируйте папку проекта",
      },
      ssh: {
        ready: false,
        hosts: 0,
        allowed: isSshAllowed(),
        sources: [] as string[],
      },
      flow: "Apply → verify → Commit → Push → Deploy",
    });
  }

  const [verify, deploy, ssh] = await Promise.all([
    loadVerifyCommands(path),
    loadDeployPresets(path),
    loadSshAllowlist(path),
  ]);
  const deployAllowed = isDeployAllowed();
  const sshAllowed = isSshAllowed();

  return c.json({
    path,
    verify: {
      ready: verify.commands.length > 0,
      commands: verify.commands.map((cmd) => cmd.name),
      sources: verify.sources,
    },
    deploy: {
      ready: deploy.presets.length > 0 && deployAllowed,
      presets: deploy.presets.map((p) => p.name),
      allowed: deployAllowed,
      hint:
        deploy.presets.length === 0
          ? "Нужен .lia/deploy.json"
          : !deployAllowed
            ? "Пресеты есть — включите LIA_ALLOW_DEPLOY=1"
            : undefined,
    },
    ssh: {
      ready: ssh.hosts.length > 0 && sshAllowed,
      hosts: ssh.hosts.length,
      allowed: sshAllowed,
      sources: ssh.sources,
      hint:
        ssh.hosts.length === 0
          ? "Нужен allowlist (.lia/ssh-allowlist.json или LIA_SSH_ALLOWLIST)"
          : !sshAllowed
            ? "Хосты есть — включите LIA_ALLOW_SSH=1"
            : undefined,
    },
    flow: "Apply → verify → Commit → Push → Deploy",
  });
});

// POST / — create + auto-start
agentRoute.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const data = parsed.data satisfies CreateAgentTaskRequest;

  const episode = getEpisode(data.episodeId);
  if (!episode) {
    return c.json({ error: "episode_not_found", episodeId: data.episodeId }, 404);
  }

  const requestedScope = resolveDefaultFsScope(data.episodeId, data.fsScope);
  const scopeCheck = validateFsScope(data.episodeId, requestedScope);
  if (!scopeCheck.ok) {
    return c.json(
      { error: scopeCheck.error, message: scopeCheck.message },
      400,
    );
  }

  const task = createTask({
    episodeId: data.episodeId,
    goal: data.goal,
    templateName: data.template ?? null,
    toolsWhitelist: data.toolsWhitelist ?? null,
    fsScope: scopeCheck.path,
    maxSteps:
      data.maxSteps ??
      (data.template === "coder" ? 40 : data.template === "researcher" ? 30 : 25),
    maxDurationSec: data.maxDurationSec,
  });

  const autoStart = data.autoStart !== false;
  if (autoStart) {
    void runAgentTask(
      task.id,
      {
        onEvent: () => {},
        onDone: () => logger.info({ taskId: task.id }, "agent task done"),
        onError: (err) => logger.error({ taskId: task.id, err }, "agent task error"),
      },
      undefined,
    ).catch((e) => logger.error({ err: e, taskId: task.id }, "agent runner crashed"));
  }

  return c.json({ task }, 201);
});

// GET /:id — get single task
agentRoute.get("/:id", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }
  return c.json({ task });
});

// POST /:id/cancel — cancel a running task
agentRoute.post("/:id/cancel", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return c.json({ error: "already_finished", status: task.status }, 400);
  }
  cancelWaiting(id, "cancelled");
  cancelUiConfirm(id, "cancelled");
  updateTaskStatus(id, "cancelled", { error: "Cancelled by user" });
  logger.info({ taskId: id }, "agent task cancelled");
  return c.json({ ok: true, id });
});

// POST /:id/input — answer ask_user
agentRoute.post("/:id/input", async (c) => {
  const id = c.req.param("id");
  const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }
  if (task.status !== "waiting_input") {
    return c.json(
      { error: "not_waiting", status: task.status, message: `task is ${task.status}, not waiting_input` },
      400,
    );
  }
  if (!isWaiting(id)) {
    return c.json(
      {
        error: "waiting_state_lost",
        message: "Сессия ожидания потеряна (перезапуск сервера). Запустите задачу снова.",
      },
      409,
    );
  }

  const ok = resolveWaiting(id, parsed.data.answer);
  if (!ok) {
    return c.json({ error: "failed_to_resolve" }, 500);
  }

  updateTaskStatus(id, "executing");
  logger.info({ taskId: id, answerPreview: parsed.data.answer.slice(0, 80) }, "agent input accepted");
  return c.json({ ok: true });
});

// POST /:id/git-confirm — confirm/reject pending git/deploy/ssh actions
agentRoute.post("/:id/git-confirm", async (c) => {
  return confirmActionHandler(c);
});

// POST /:id/action-confirm — preferred generic alias
agentRoute.post("/:id/action-confirm", async (c) => {
  return confirmActionHandler(c);
});

async function confirmActionHandler(c: Context) {
  const id = c.req.param("id");
  const schema = z.object({
    actionId: z.string().min(1).max(100),
    decision: z.enum(["confirm", "reject"]),
    message: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const task = getTask(id);
  if (!task) return c.json({ error: "not_found", id }, 404);

  const pending = getPendingUiAction(id);
  if (!pending || !isUiWaiting(id)) {
    return c.json(
      {
        error: "no_pending_action",
        message: "Нет ожидающего действия (git/deploy/ssh). Возможно, сервер перезапускался.",
      },
      409,
    );
  }
  if (pending.id !== parsed.data.actionId) {
    return c.json({ error: "action_mismatch", expected: pending.id }, 400);
  }

  const ok = resolveUiConfirm(
    id,
    parsed.data.decision === "confirm"
      ? { decision: "confirm", message: parsed.data.message }
      : { decision: "reject" },
  );
  if (!ok) return c.json({ error: "failed_to_resolve" }, 500);

  logger.info(
    { taskId: id, actionId: pending.id, kind: pending.kind, decision: parsed.data.decision },
    "UI confirmation accepted",
  );
  return c.json({ ok: true, kind: pending.kind, decision: parsed.data.decision });
}

// GET /:id/file-changes
agentRoute.get("/:id/file-changes", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }
  const changes = listTaskFileChanges(id).map((r) => ({
    id: r.id,
    taskId: r.taskId,
    path: r.path,
    tool: r.tool,
    status: r.status,
    created: r.created,
    canUndo: r.canUndo,
    diff: r.diff,
    createdAt: r.createdAt,
  }));
  return c.json({ changes });
});

// POST /:id/file-apply
agentRoute.post("/:id/file-apply", async (c) => {
  const id = c.req.param("id");
  const parsed = fileChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }
  if (!task.fsScope) {
    return c.json({ error: "no_fs_scope" }, 400);
  }

  const result = await applyFileChange(id, parsed.data.changeId, task.fsScope);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  const event: AgentEvent = {
    type: "file_applied",
    changeId: result.record.id,
    path: result.record.path,
    ts: Date.now(),
  };
  appendEvent(id, event);

  return c.json({
    ok: true,
    change: {
      id: result.record.id,
      path: result.record.path,
      status: result.record.status,
      canUndo: result.record.canUndo,
    },
  });
});

// POST /:id/file-reject
agentRoute.post("/:id/file-reject", async (c) => {
  const id = c.req.param("id");
  const parsed = fileChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }

  const result = await rejectFileChange(id, parsed.data.changeId);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  const event: AgentEvent = {
    type: "file_rejected",
    changeId: result.record.id,
    path: result.record.path,
    ts: Date.now(),
  };
  appendEvent(id, event);

  return c.json({ ok: true, change: { id: result.record.id, path: result.record.path, status: result.record.status } });
});

// POST /:id/file-undo
agentRoute.post("/:id/file-undo", async (c) => {
  const id = c.req.param("id");
  const parsed = fileChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const task = getTask(id);
  if (!task) return c.json({ error: "not_found", id }, 404);
  if (!task.fsScope) return c.json({ error: "no_fs_scope" }, 400);

  const result = await undoFileChange(id, parsed.data.changeId, task.fsScope);
  if (!result.ok) return c.json({ error: result.error }, 400);

  const event: AgentEvent = {
    type: "file_undone",
    changeId: result.record.id,
    path: result.record.path,
    ts: Date.now(),
  };
  appendEvent(id, event);

  return c.json({
    ok: true,
    change: { id: result.record.id, path: result.record.path, status: result.record.status },
  });
});

// POST /:id/file-apply-all
agentRoute.post("/:id/file-apply-all", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found", id }, 404);
  if (!task.fsScope) return c.json({ error: "no_fs_scope" }, 400);

  const { applied, errors } = await applyAllPending(id, task.fsScope);
  for (const record of applied) {
    appendEvent(id, {
      type: "file_applied",
      changeId: record.id,
      path: record.path,
      ts: Date.now(),
    });
  }
  return c.json({
    ok: true,
    applied: applied.map((r) => ({ id: r.id, path: r.path })),
    errors,
  });
});

// POST /:id/file-reject-all
agentRoute.post("/:id/file-reject-all", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found", id }, 404);

  const { rejected } = await rejectAllPending(id);
  for (const record of rejected) {
    appendEvent(id, {
      type: "file_rejected",
      changeId: record.id,
      path: record.path,
      ts: Date.now(),
    });
  }
  return c.json({
    ok: true,
    rejected: rejected.map((r) => ({ id: r.id, path: r.path })),
  });
});

// POST /:id/file-undo-all
agentRoute.post("/:id/file-undo-all", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found", id }, 404);
  if (!task.fsScope) return c.json({ error: "no_fs_scope" }, 400);

  const { undone, errors } = await undoAllApplied(id, task.fsScope);
  for (const record of undone) {
    appendEvent(id, {
      type: "file_undone",
      changeId: record.id,
      path: record.path,
      ts: Date.now(),
    });
  }
  return c.json({
    ok: true,
    undone: undone.map((r) => ({ id: r.id, path: r.path })),
    errors,
  });
});

// GET /:id/stream — SSE stream of events
agentRoute.get("/:id/stream", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found", id }, 404);
  }

  return streamSSE(c, async (stream) => {
    for (const event of task.events) {
      await stream.writeSSE({ data: JSON.stringify(event) });
    }

    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      await stream.writeSSE({
        data: JSON.stringify({
          type: "done",
          ts: Date.now(),
        } satisfies AgentEvent),
      });
      return;
    }

    let lastEventCount = task.events.length;
    let pollCount = 0;
    const MAX_POLLS = 3600;

    while (pollCount < MAX_POLLS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      pollCount++;

      const currentTask = getTask(id);
      if (!currentTask) break;

      const newEvents = currentTask.events.slice(lastEventCount);
      for (const event of newEvents) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
      lastEventCount = currentTask.events.length;

      if (
        currentTask.status === "done" ||
        currentTask.status === "failed" ||
        currentTask.status === "cancelled"
      ) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "done",
            ts: Date.now(),
          } satisfies AgentEvent),
        });
        break;
      }

      if (c.req.raw.signal.aborted) break;
    }
  });
});
