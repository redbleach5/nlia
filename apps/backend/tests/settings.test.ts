/**
 * Settings GET/PUT + capability smoke tests.
 *
 * Verifies the model slot persistence roundtrip and capability reporting.
 * Uses a mocked fetch for /api/tags so tests don't require a running Ollama.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { _resetForTests, reloadSettings, isEmbedModelName } from "../src/llm/ollama.js";
import type { CapabilityProfile, ModelSlots } from "@lia/shared";

// Mock global fetch for Ollama /api/tags + /api/embed calls
const mockTagsResponse = {
  models: [
    { name: "qwen3:8b" },
    { name: "qwen3:32b" },
    { name: "nomic-embed-text" },
  ],
};

describe("Settings + Capability API", () => {
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
    // Default mock: Ollama is healthy
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify(mockTagsResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("GET /api/settings returns defaults on first run", async () => {
    // Tests previously seeded settings from an earlier dev run may leave
    // values in the DB; clear model slots first so the "first run" scenario
    // is deterministic regardless of share-state.
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "", heavy: "", chat: "qwen3:8b" }),
    });

    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelSlots;
    expect(body.baseUrl).toBe("http://127.0.0.1:11434");
    expect(body.chat).toBeTruthy();
    expect(typeof body.chat).toBe("string");
    // agent/heavy default to empty (same as chat / no escalate)
    expect(body.agent).toBe("");
    expect(body.heavy).toBe("");
  });

  it("PUT /api/settings persists model slots", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat: "qwen3:8b",
        agent: "qwen3:32b",
        embed: "nomic-embed-text",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelSlots;
    expect(body.chat).toBe("qwen3:8b");
    expect(body.agent).toBe("qwen3:32b");
    expect(body.embed).toBe("nomic-embed-text");

    // Verify persistence: GET should return the same values
    const getRes = await app.request("/api/settings");
    const getBody = (await getRes.json()) as ModelSlots;
    expect(getBody.chat).toBe("qwen3:8b");
    expect(getBody.agent).toBe("qwen3:32b");
  });

  it("PUT /api/settings with empty agent clears the slot", async () => {
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "qwen3:32b" }),
    });

    const clearRes = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "" }),
    });
    const body = (await clearRes.json()) as ModelSlots;
    expect(body.agent).toBe("");
  });

  it("GET /api/capability reports Ollama health + effective models", async () => {
    // Configure a known slot configuration
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat: "qwen3:8b",
        agent: "qwen3:32b",
        embed: "nomic-embed-text",
      }),
    });

    const res = await app.request("/api/capability");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CapabilityProfile;
    expect(body.ollamaOk).toBe(true);
    expect(body.models).toContain("qwen3:8b");
    expect(body.models).toContain("qwen3:32b");
    expect(body.chatModels).toContain("qwen3:8b");
    expect(body.chatModels).not.toContain("nomic-embed-text");
    expect(body.embedModels).toContain("nomic-embed-text");
    expect(body.effective.chat).toBe("qwen3:8b");
    expect(body.effective.agent).toBe("qwen3:32b");
    expect(body.effective.embed).toBe("nomic-embed-text");
    expect(body.embedExplicit).toBe(true);
  });

  it("GET /api/capability normalizes :latest tag for embed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "qwen3:8b", embed: "nomic-embed-text" }),
    });

    const res = await app.request("/api/capability");
    const body = (await res.json()) as CapabilityProfile;
    expect(body.effective.embed).toBe("nomic-embed-text:latest");
  });

  it("PUT /api/settings rejects embed model in chat slot", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "nomic-embed-text" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_model_slot");
  });

  it("GET /api/capability falls back when configured model not pulled", async () => {
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "nonexistent-model" }),
    });

    const res = await app.request("/api/capability");
    const body = (await res.json()) as CapabilityProfile;
    // Should fall back to first non-embed model
    expect(body.ollamaOk).toBe(true);
    expect(body.effective.chat).not.toBe("nonexistent-model");
    expect(["qwen3:8b", "qwen3:32b"]).toContain(body.effective.chat);
    expect(body.chatFallback).toBe(true);
  });

  it("resolveModelName never returns embed models for chat role", async () => {
    const { resolveModelName } = await import("../src/llm/ollama.js");
    const available = ["nomic-embed-text:latest", "gemma4:latest"];
    // Without role filter, "nomic" would partial-match the embed model
    const result = resolveModelName("nomic", available, "chat");
    expect(result.resolved).toBe("gemma4:latest");
    expect(isEmbedModelName(result.resolved)).toBe(false);
  });

  it("GET /api/capability handles Ollama unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const res = await app.request("/api/capability");
    const body = (await res.json()) as CapabilityProfile;
    expect(body.ollamaOk).toBe(false);
    expect(body.error).toContain("ECONNREFUSED");
    expect(body.models).toEqual([]);
  });
});
