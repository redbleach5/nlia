/**
 * Chat + attachments integration test.
 *
 * Verifies that when a chat message is sent with attachmentIds:
 *   1. The user message row has attachmentsJson populated with the resource meta
 *   2. The chat pipeline resolves the inline resources and builds an attachments
 *      context block (we can't directly inspect the system prompt, but we verify
 *      the user message's attachmentsJson snapshot — that's the persisted proof)
 *
 * Full system prompt inspection is covered by unit tests of buildAttachmentsContext.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { _resetForTests, reloadSettings } from "../src/llm/ollama.js";
import { createEpisode } from "../src/services/episodes.js";
import { listMessages } from "../src/services/messages.js";
import { attachInline, buildAttachmentsContext } from "../src/workspace/service.js";

describe("Chat + attachments integration", () => {
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
    const ep = createEpisode({ title: "Chat attachments test" });
    episodeId = ep.id;
  });

  it("buildAttachmentsContext returns null for no resources", () => {
    expect(buildAttachmentsContext([])).toBeNull();
  });

  it("buildAttachmentsContext returns formatted block for text resources", async () => {
    const resource = await attachInline({
      episodeId,
      originalName: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Important context for the conversation."),
    });

    const block = buildAttachmentsContext([resource]);
    expect(block).not.toBeNull();
    expect(block).toContain("ВЛОЖЕНИЯ В ЧАТЕ");
    expect(block).toContain("note.txt");
    expect(block).toContain("Important context for the conversation.");
  });

  it("buildAttachmentsContext skips resources without textPreview", async () => {
    // Create an "image" resource (textPreview is null for images)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    ]);
    const resource = await attachInline({
      episodeId,
      originalName: "pic.png",
      mimeType: "image/png",
      buffer: pngHeader,
    });

    const block = buildAttachmentsContext([resource]);
    // Image has no textPreview → block should be null
    expect(block).toBeNull();
  });

  it("chat with attachmentIds persists attachmentsJson on user message", async () => {
    // Attach a file
    const resource = await attachInline({
      episodeId,
      originalName: "context.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Some context for the LLM."),
    });

    // Mock fetch so the chat stream errors out quickly (we only care about
    // the user message persistence, not the LLM response)
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
        throw new Error("simulated Ollama failure");
      }),
    );

    // Send chat with attachmentIds
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        text: "What does the attachment say?",
        episodeId,
        attachmentIds: [resource.id],
      }),
    });

    expect(res.status).toBe(200); // SSE stream starts even though LLM will fail

    // Wait for the stream to drain
    await res.text();

    // Verify the user message has attachmentsJson populated
    const messages = listMessages(episodeId);
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("What does the attachment say?");

    const attachments = userMsgs[0].attachments;
    expect(attachments).not.toBeNull();
    expect(attachments).toHaveLength(1);
    expect(attachments![0].name).toBe("context.txt");
    expect(attachments![0].mimeType).toBe("text/plain");
    expect(attachments![0].kind).toBe("text");
  });

  it("chat with unknown attachmentIds still persists user message (graceful degradation)", async () => {
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
      body: JSON.stringify({
        text: "Hello",
        episodeId,
        attachmentIds: ["nonexistent-resource-id"],
      }),
    });

    expect(res.status).toBe(200);
    await res.text();

    // User message persisted with empty attachments (unknown ids filtered out)
    const messages = listMessages(episodeId);
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].attachments).toBeNull(); // empty array → null in DB
  });
});
