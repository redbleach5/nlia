/**
 * Agent tools — filesystem, KB, web, orchestration.
 *
 * Per docs/ARCHITECTURE.md § 8.2 — tool categories A–E.
 * M6 adds symbol tools (search_codebase, list_references).
 * M5.5 adds external MCP tools (Addendum A.1).
 */

import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { registerTool } from "../tool-registry.js";
import { hybridSearch } from "../../kb/search.js";
import { list as listResources } from "../../workspace/service.js";
import { webSearch } from "./web-search.js";
import { fetchPage } from "./fetch-page.js";
import { runCommand, isShellAllowed } from "./run-command.js";
import {
  getPendingFileOverlay,
  proposeOrApplyFileChange,
  toRelativePath,
} from "../file-changes.js";
import { waitForUserAnswer } from "../wait-input.js";
import { preFlightAskUser } from "../preflight.js";
import { getTask, updateTaskStatus } from "../service.js";
import { createDecision } from "../../memory/decisions.js";

// Register code symbol tools (M6) + apply_patch
import "./code.js";
import "./patch.js";
import "./git.js";
import "./deploy.js";
import "./ssh.js";
import "./verify.js";

/** Per-task PreFlightAskUser retry counter (in-memory). */
const preflightRetries = new Map<string, number>();

// ─── A. Filesystem tools ──────────────────────────────────────────────

/** Resolve a path relative to fsScope, preventing escape. */
function resolveScopedPath(fsScope: string | null, inputPath: string): string {
  if (!fsScope) throw new Error("No fsScope set for this task");
  const abs = isAbsolute(inputPath) ? inputPath : resolve(fsScope, inputPath);
  const rel = relative(fsScope, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes fsScope: ${inputPath}`);
  }
  return abs;
}

registerTool({
  name: "list_tree",
  description: "List files and directories in a path within the workspace. Returns names + types.",
  inputSchema: z.object({
    path: z.string().describe("Relative or absolute path within fsScope"),
  }),
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, _ctx) => {
    const { path } = input as { path: string };
    const ctx = _ctx;
    const absPath = resolveScopedPath(ctx.fsScope, path);
    const entries = await readdir(absPath, { withFileTypes: true });
    return entries.slice(0, 200).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }));
  },
});

registerTool({
  name: "read_file",
  description: "Read the content of a file within the workspace.",
  inputSchema: z.object({
    path: z.string().describe("Relative or absolute path within fsScope"),
    maxChars: z.number().optional().describe("Max chars to read (default 50000)"),
  }),
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { path, maxChars } = input as { path: string; maxChars?: number };
    const absPath = resolveScopedPath(ctx.fsScope, path);
    const rel = relative(ctx.fsScope!, absPath);
    const overlay = getPendingFileOverlay(ctx.taskId, rel);
    const content = overlay ?? (await readFile(absPath, "utf-8"));
    const limit = maxChars ?? 50000;
    const truncated = content.length > limit;
    return {
      content: truncated ? content.slice(0, limit) : content,
      truncated,
      path: rel,
      pendingOverlay: overlay != null,
    };
  },
});

registerTool({
  name: "write_file",
  description:
    "Propose writing one full file within the workspace (staged for Apply). " +
    "For features spanning multiple files prefer write_files. " +
    "apply_patch is only for tiny follow-up fixes.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { path, content } = input as { path: string; content: string };
    const rel = toRelativePath(ctx.fsScope!, path);
    const record = await proposeOrApplyFileChange({
      taskId: ctx.taskId,
      fsScope: ctx.fsScope!,
      path: rel,
      tool: "write_file",
      proposedContent: content,
    });
    if (!record.applied) {
      ctx.emit({
        type: "file_propose",
        changeId: record.id,
        path: record.path,
        tool: "write_file",
        created: record.created,
        diff: record.diff,
        ts: Date.now(),
      });
    } else {
      ctx.emit({
        type: "file_applied",
        changeId: record.id,
        path: record.path,
        ts: Date.now(),
      });
    }
    return {
      written: record.applied,
      pending: !record.applied,
      changeId: record.id,
      path: record.path,
      bytes: content.length,
      message: record.applied
        ? "File written to disk (auto-apply)."
        : "File proposed — waiting for user Apply in the UI. read_file sees the pending overlay.",
    };
  },
});

registerTool({
  name: "write_files",
  description:
    "PRIMARY tool for volume coding: propose many related files in one step (Composer-style). " +
    "Use for features, modules, scaffolding, refactors. Pass complete file contents. " +
    "Each file is staged for user Apply unless auto-apply is enabled. " +
    "Call repeatedly in batches (core → wiring → tests) rather than tiny single-line patches.",
  inputSchema: z.object({
    files: z
      .array(
        z.object({
          path: z.string(),
          content: z.string(),
        }),
      )
      .min(1)
      .max(40),
  }),
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { files } = input as { files: Array<{ path: string; content: string }> };
    const results: Array<{
      path: string;
      changeId: string;
      pending: boolean;
      created: boolean;
    }> = [];

    for (const f of files) {
      const rel = toRelativePath(ctx.fsScope!, f.path);
      const record = await proposeOrApplyFileChange({
        taskId: ctx.taskId,
        fsScope: ctx.fsScope!,
        path: rel,
        tool: "write_files",
        proposedContent: f.content,
      });
      if (!record.applied) {
        ctx.emit({
          type: "file_propose",
          changeId: record.id,
          path: record.path,
          tool: "write_files",
          created: record.created,
          diff: record.diff,
          ts: Date.now(),
        });
      } else {
        ctx.emit({
          type: "file_applied",
          changeId: record.id,
          path: record.path,
          ts: Date.now(),
        });
      }
      results.push({
        path: record.path,
        changeId: record.id,
        pending: !record.applied,
        created: record.created,
      });
    }

    const pendingCount = results.filter((r) => r.pending).length;
    return {
      count: results.length,
      pendingCount,
      files: results,
      message:
        pendingCount > 0
          ? `${results.length} files proposed (${pendingCount} awaiting Apply).`
          : `${results.length} files written (auto-apply).`,
    };
  },
});

registerTool({
  name: "grep",
  description: "Search for a pattern in files within the workspace. Simple substring match.",
  inputSchema: z.object({
    pattern: z.string().max(200),
    path: z.string().optional().describe("Subdirectory to search (default: fsScope root)"),
  }),
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const { pattern, path } = input as { pattern: string; path?: string };
    const searchRoot = path ? resolveScopedPath(ctx.fsScope, path) : ctx.fsScope!;
    const results: Array<{ file: string; line: number; text: string }> = [];

    async function walk(dir: string, depth: number) {
      if (depth > 5 || results.length > 100) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const content = await readFile(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && results.length < 100; i++) {
              if (lines[i]!.includes(pattern)) {
                results.push({
                  file: relative(ctx.fsScope!, fullPath),
                  line: i + 1,
                  text: lines[i]!.slice(0, 200),
                });
              }
            }
          } catch {
            // binary or unreadable — skip
          }
        }
      }
    }

    await walk(searchRoot, 0);
    return { pattern, matches: results, total: results.length };
  },
});

// ─── B. KB tools ──────────────────────────────────────────────────────

registerTool({
  name: "search_sources",
  description: "Semantic search across KB resources (documents, folders). Returns relevant chunks.",
  inputSchema: z.object({
    query: z.string().max(1000),
    limit: z.number().optional(),
  }),
  available: (resources) =>
    resources.some((r) => r.kind === "folder" || r.kind === "codebase" || r.kind === "url"),
  execute: async (input, ctx) => {
    const { query, limit } = input as { query: string; limit?: number };
    const result = await hybridSearch(ctx.episodeId, query, { limit: limit ?? 5 });
    return {
      results: result.results.map((r) => ({
        content: r.content.slice(0, 500),
        resourceName: r.resourceName,
        score: r.score,
        filePath: r.metadata.filePath,
      })),
      totalChunks: result.totalChunks,
    };
  },
});

registerTool({
  name: "list_sources",
  description: "List all KB resources available in this episode.",
  inputSchema: z.object({}),
  available: () => true,
  execute: async (_input, ctx) => {
    const resources = listResources(ctx.episodeId);
    return resources.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      chunkCount: r.chunkCount,
    }));
  },
});

// ─── C. Web tools (real implementations — M5.5 patch) ────────────────

registerTool({
  name: "web_search",
  description: "Search the web for current information. Returns search results with titles + URLs.",
  inputSchema: z.object({
    query: z.string().max(500),
  }),
  available: () => true,
  execute: async (input) => webSearch((input as { query: string }).query),
});

registerTool({
  name: "fetch_page",
  description: "Fetch the content of a web page. Returns text extracted from HTML.",
  inputSchema: z.object({
    url: z.string().url(),
  }),
  available: () => true,
  execute: async (input) => fetchPage((input as { url: string }).url),
});

// ─── D. Orchestration tools ───────────────────────────────────────────
// finalize is intercepted in orchestrator onStepFinish.
// ask_user actually blocks here until POST /api/agent/:id/input.

registerTool({
  name: "make_plan",
  description:
    "Create a short execution plan for a large coding/research task. " +
    "Use early for multi-file features: list files to create/change and order of batches.",
  inputSchema: z.object({
    steps: z.array(z.string()).describe("Ordered list of steps to execute"),
  }),
  available: () => true,
  execute: async (input) => {
    const { steps } = input as { steps: string[] };
    return { plan: steps, stepCount: steps.length };
  },
});

registerTool({
  name: "finalize",
  description: "Finalize the task with a summary. This ends the agent loop.",
  inputSchema: z.object({
    summary: z.string().max(2000).describe("Final summary of what was accomplished"),
  }),
  available: () => true,
  execute: async (input) => {
    const { summary } = input as { summary: string };
    return { finalized: true, summary };
  },
});

registerTool({
  name: "ask_user",
  description:
    "Ask the user a clarifying question and wait for their answer. " +
    "Use only when you cannot proceed without input.",
  inputSchema: z.object({
    question: z.string().max(1000).describe("The question to ask the user"),
  }),
  available: () => true,
  execute: async (input, ctx) => {
    const { question } = input as { question: string };
    const events = getTask(ctx.taskId)?.events ?? [];
    const retries = preflightRetries.get(ctx.taskId) ?? 0;
    const gate = await preFlightAskUser(ctx.episodeId, ctx.taskId, events, retries);

    if (gate === "continue") {
      preflightRetries.set(ctx.taskId, retries + 1);
      createDecision({
        episodeId: ctx.episodeId,
        taskId: ctx.taskId,
        situation: "Запрошен ask_user у модели",
        options: ["ask_user", "continue"],
        chosen: "continue",
        rationale: "PreFlightAskUser Gate подсказал сначала попробовать другой путь",
        modelRole: "agent",
      });
      ctx.emit({
        type: "status",
        label: `Пробую альтернативный подход (${retries + 1}/2)…`,
        ts: Date.now(),
      });
      return {
        asked: false,
        hint: "Не спрашивай пользователя сейчас — попробуй другой tool/подход (web_search, search_sources, read_file).",
      };
    }

    ctx.emit({ type: "ask_user", question, ts: Date.now() });
    updateTaskStatus(ctx.taskId, "waiting_input");

    createDecision({
      episodeId: ctx.episodeId,
      taskId: ctx.taskId,
      situation: "Запрошен ask_user у модели",
      options: ["ask_user", "continue"],
      chosen: "ask_user",
      rationale: question.slice(0, 500),
      modelRole: "agent",
    });

    try {
      const answer = await waitForUserAnswer(ctx.taskId, question);
      updateTaskStatus(ctx.taskId, "executing");
      ctx.emit({ type: "user_answer", answer: answer.slice(0, 2000), ts: Date.now() });
      return { asked: true, question, answer };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const task = getTask(ctx.taskId);
      if (task && task.status === "waiting_input") {
        updateTaskStatus(ctx.taskId, "failed", { error: msg });
      }
      throw e;
    } finally {
      preflightRetries.delete(ctx.taskId);
    }
  },
});

// ─── E. Execution tools (gated by LIA_ALLOW_SHELL) ────────────────────

registerTool({
  name: "run_command",
  description: "Run a shell command in the workspace. Use for builds, tests, etc.",
  inputSchema: z.object({
    command: z.string().max(500),
  }),
  available: (_resources, task) => task.fsScope !== null && isShellAllowed(),
  execute: async (input, ctx) => {
    const { command } = input as { command: string };
    return runCommand(command, { cwd: ctx.fsScope });
  },
});

// ─── Utility ──────────────────────────────────────────────────────────
export { resolveScopedPath };
