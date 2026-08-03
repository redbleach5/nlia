/**
 * Chat pipeline smoke test.
 *
 * Two scenarios:
 *   1. /api/chat returns 404 for unknown episode
 *   2. /api/chat with valid episode but no Ollama emits an error SSE event
 *      (verifies the SSE plumbing + error handling)
 *
 * A full happy-path test requires a real Ollama instance — covered by
 * `npm run e2e` in M8. Here we verify the wiring.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { _resetForTests, reloadSettings } from "../src/llm/ollama.js";
import { createEpisode } from "../src/services/episodes.js";
import { listMessages } from "../src/services/messages.js";

describe("POST /api/chat", () => {
  let episodeId: string;

  beforeAll(() => {
    getDb();
    pushSchema();
  });

  afterAll(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    _resetForTests();
    await reloadSettings();
    // Create a fresh episode for each test
    const ep = createEpisode({ title: "Chat test episode" });
    episodeId = ep.id;
  });

  it("returns 404 for unknown episode", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", episodeId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for empty text", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   ", episodeId }),
    });
    expect(res.status).toBe(400);
  });

  it("persists the user message even when Ollama is unreachable", async () => {
    // Mock fetch to simulate Ollama being down
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // /v1/chat/completions — simulate Ollama connection refused
        throw new Error("ECONNREFUSED");
      }),
    );

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ text: "Hello Lia", episodeId }),
    });

    // Should be 200 (SSE stream starts) — error is emitted as an event
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Drain the stream
    const text = await res.text();
    expect(text).toContain("data:");

    // The user message should have been persisted before the LLM call
    const messages = listMessages(episodeId);
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("Hello Lia");
  });

  it("emits a status SSE event before any LLM call", async () => {
    // Mock fetch so the stream errors out quickly
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error("simulated failure");
      }),
    );

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ text: "test", episodeId }),
    });

    const text = await res.text();
    // First SSE event should be a status: "Думаю…"
    expect(text).toMatch(/data:.*"type":"status".*"Думаю…"/);
  });
});
