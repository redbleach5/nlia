/**
 * Agent module tests — tool registry, loop detector, preflight, service, orchestrator.
 *
 * Tests the M5 agent stack:
 *   - Tool registry: registration, filtering by availability
 *   - Loop detector: pattern loop detection, empty results
 *   - PreFlightAskUser gate: budget exhaustion, path suggestions
 *   - Agent service: create/get/list/update status, events persistence
 *   - Agent API routes: create task, list, get, cancel
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import {
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  appendEvent,
  sweepStaleTasks,
} from "../src/agent/service.js";
import { buildActiveTools, listAllTools } from "../src/agent/tool-registry.js";
import "../src/agent/tools/index.js"; // Register all tools
import { detectLoop } from "../src/agent/loop-detector.js";
import { preFlightAskUser } from "../src/agent/preflight.js";
import type { AgentEvent, Resource } from "@lia/shared";

describe("Tool registry", () => {
  it("has tools registered", () => {
    const tools = listAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain("finalize");
    expect(names).toContain("ask_user");
    expect(names).toContain("read_file");
    expect(names).toContain("apply_patch");
    expect(names).toContain("search_sources");
    expect(names).toContain("web_search");
  });

  it("filters tools by availability (fsScope required for fs tools)", () => {
    const resources: Resource[] = [];
    const ctx = { episodeId: "test", taskId: "test", fsScope: null, emit: () => {} };

    // Without fsScope: fs tools should be filtered out
    const toolsNoFs = buildActiveTools(resources, { fsScope: null, toolsWhitelist: null }, ctx);
    expect(toolsNoFs.read_file).toBeUndefined();
    expect(toolsNoFs.write_file).toBeUndefined();
    expect(toolsNoFs.list_tree).toBeUndefined();

    // With fsScope: fs tools should be available
    const toolsWithFs = buildActiveTools(resources, { fsScope: "/tmp", toolsWhitelist: null }, ctx);
    expect(toolsWithFs.read_file).toBeDefined();
    expect(toolsWithFs.write_file).toBeDefined();
  });

  it("filters tools by toolsWhitelist", () => {
    const ctx = { episodeId: "test", taskId: "test", fsScope: "/tmp", emit: () => {} };
    const tools = buildActiveTools(
      [],
      { fsScope: "/tmp", toolsWhitelist: ["read_file", "finalize"] },
      ctx,
    );
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools.read_file).toBeDefined();
    expect(tools.finalize).toBeDefined();
    expect(tools.write_file).toBeUndefined();
  });

  it("KB tools require folder/codebase resources", () => {
    const ctx = { episodeId: "test", taskId: "test", fsScope: null, emit: () => {} };

    // No resources → search_sources unavailable
    const noKb = buildActiveTools([], { fsScope: null, toolsWhitelist: null }, ctx);
    expect(noKb.search_sources).toBeUndefined();

    // With folder resource → search_sources available
    const withFolder: Resource[] = [
      {
        id: "r1", episodeId: "e1", kind: "folder", name: "docs",
        config: { distributionAllowed: true }, status: "ready", chunkCount: 5,
        tags: [], errorMessage: null, contentHash: null, byteSize: null,
        createdAt: 0, updatedAt: 0, lastIndexedAt: null,
      },
    ];
    const withKb = buildActiveTools(withFolder, { fsScope: null, toolsWhitelist: null }, ctx);
    expect(withKb.search_sources).toBeDefined();
  });
});

describe("Loop detector", () => {
  it("returns null for < 3 tool_end events", () => {
    const events: AgentEvent[] = [
      { type: "tool_end", tool: "read_file", success: true, summary: "content", ts: 1 },
      { type: "tool_end", tool: "read_file", success: true, summary: "content", ts: 2 },
    ];
    expect(detectLoop(events)).toBeNull();
  });

  it("detects pattern loop (same tool + same summary 3 times)", () => {
    const events: AgentEvent[] = [
      { type: "tool_end", tool: "grep", success: true, summary: "no matches", ts: 1 },
      { type: "tool_end", tool: "grep", success: true, summary: "no matches", ts: 2 },
      { type: "tool_end", tool: "grep", success: true, summary: "no matches", ts: 3 },
    ];
    const hint = detectLoop(events);
    expect(hint).not.toBeNull();
    expect(hint!.type).toBe("pattern_loop");
    expect(hint!.message).toContain("grep");
  });

  it("detects empty results pattern", () => {
    const events: AgentEvent[] = [
      { type: "tool_end", tool: "search_sources", success: true, summary: "0 items", ts: 1 },
      { type: "tool_end", tool: "grep", success: true, summary: "0 items", ts: 2 },
      { type: "tool_end", tool: "list_tree", success: true, summary: "0 items", ts: 3 },
    ];
    const hint = detectLoop(events);
    expect(hint).not.toBeNull();
    expect(hint!.type).toBe("empty_results");
  });

  it("returns null when tools succeed with different results", () => {
    const events: AgentEvent[] = [
      { type: "tool_end", tool: "read_file", success: true, summary: "file1 content", ts: 1 },
      { type: "tool_end", tool: "read_file", success: true, summary: "file2 content", ts: 2 },
      { type: "tool_end", tool: "read_file", success: true, summary: "file3 content", ts: 3 },
    ];
    expect(detectLoop(events)).toBeNull();
  });
});

describe("PreFlightAskUser gate", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });
  afterAll(() => closeDb());

  it("returns 'ask' when budget exhausted (retries >= 2)", async () => {
    const ep = createEpisode({ title: "preflight test" });
    const result = await preFlightAskUser(ep.id, "task1", [], 2);
    expect(result).toBe("ask");
  });

  it("returns 'continue' when no web search has been tried", async () => {
    const ep = createEpisode({ title: "preflight web test" });
    // Mock heavy model as null (no heavy configured)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error("not mocked");
      }),
    );

    const result = await preFlightAskUser(ep.id, "task2", [], 0);
    expect(result).toBe("continue");
    vi.restoreAllMocks();
  });
});

describe("Agent service", () => {
  let episodeId: string;

  beforeAll(() => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Agent service test" });
    episodeId = ep.id;
  });
  afterAll(() => closeDb());

  it("creates and retrieves a task", () => {
    const task = createTask({
      episodeId,
      goal: "Find a bug in the code",
      templateName: "coder",
    });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.goal).toBe("Find a bug in the code");

    const fetched = getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.goal).toBe("Find a bug in the code");
  });

  it("lists tasks by episode", () => {
    createTask({ episodeId, goal: "Task 1" });
    createTask({ episodeId, goal: "Task 2" });
    const tasks = listTasks(episodeId);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("updates task status", () => {
    const task = createTask({ episodeId, goal: "Status test" });
    updateTaskStatus(task.id, "executing");
    expect(getTask(task.id)!.status).toBe("executing");

    updateTaskStatus(task.id, "done", { resultSummary: "Completed" });
    expect(getTask(task.id)!.status).toBe("done");
    expect(getTask(task.id)!.resultSummary).toBe("Completed");
    expect(getTask(task.id)!.completedAt).not.toBeNull();
  });

  it("appends events to eventsJson", () => {
    const task = createTask({ episodeId, goal: "Events test" });
    appendEvent(task.id, { type: "status", label: "starting", ts: Date.now() });
    appendEvent(task.id, { type: "text_delta", text: "hello", ts: Date.now() });

    const updated = getTask(task.id);
    expect(updated!.events).toHaveLength(2);
    expect(updated!.events[0]!.type).toBe("status");
    expect(updated!.events[1]!.type).toBe("text_delta");
  });

  it("sweeps stale tasks on startup", () => {
    const task = createTask({ episodeId, goal: "Stale test" });
    updateTaskStatus(task.id, "executing");
    const swept = sweepStaleTasks();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getTask(task.id)!.status).toBe("failed");
  });
});

describe("Agent API routes", () => {
  let episodeId: string;

  beforeAll(() => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Agent API test" });
    episodeId = ep.id;
  });
  afterAll(() => closeDb());

  it("POST /api/agent creates a task", async () => {
    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episodeId,
        goal: "Test agent task",
        template: "general",
        autoStart: false, // don't start the runner (no Ollama)
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.id).toBeTruthy();
    expect(body.task.goal).toBe("Test agent task");
    expect(body.task.status).toBe("pending");
  });

  it("GET /api/agent lists tasks", async () => {
    const res = await app.request(`/api/agent?episodeId=${episodeId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toBeInstanceOf(Array);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/agent/:id returns single task", async () => {
    // Create a task first
    const createRes = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId, goal: "Get test", autoStart: false }),
    });
    const { task } = await createRes.json();

    const res = await app.request(`/api/agent/${task.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe(task.id);
  });

  it("POST /api/agent/:id/cancel cancels a pending task", async () => {
    const createRes = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId, goal: "Cancel test", autoStart: false }),
    });
    const { task } = await createRes.json();

    const res = await app.request(`/api/agent/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify status is cancelled
    const getRes = await app.request(`/api/agent/${task.id}`);
    const getBody = await getRes.json();
    expect(getBody.task.status).toBe("cancelled");
  });

  it("returns 404 for unknown episode", async () => {
    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId: "nonexistent", goal: "test", autoStart: false }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for empty goal", async () => {
    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId, goal: "", autoStart: false }),
    });
    expect(res.status).toBe(400);
  });
});
