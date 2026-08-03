/**
 * Episodes CRUD + ensure-default smoke tests.
 *
 * Uses the in-process Hono app.request() — no port binding.
 * Each test gets a fresh DB (vitest isolates via process per test file by default).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import type { Episode, EpisodeListItem, EnsureDefaultResponse } from "@lia/shared";

describe("Episodes API", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });

  afterAll(() => {
    closeDb();
  });

  it("POST /api/episodes/ensure-default creates the first episode if none exist, else is idempotent", async () => {
    // This test may run after other test files that created episodes in the same DB.
    // ensure-default is idempotent: if episodes already exist, created=false.
    // If the DB was just migrated (fresh), created=true.
    const res = await app.request("/api/episodes/ensure-default", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnsureDefaultResponse;
    expect(body.episodes.length).toBeGreaterThanOrEqual(1);
    // Either created the first episode (created=true) or found existing (created=false)
    if (body.created) {
      expect(body.episodeId).toBeTruthy();
      // Verify at least one is marked default
      expect(body.episodes.some((e) => e.isDefault)).toBe(true);
    } else {
      expect(body.episodeId).toBeNull();
    }
  });

  it("POST /api/episodes creates a new episode", async () => {
    const res = await app.request("/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test episode", mode: "chat" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { episode: Episode };
    expect(body.episode.title).toBe("Test episode");
    expect(body.episode.mode).toBe("chat");
    expect(body.episode.id).toBeTruthy();
  });

  it("GET /api/episodes lists all episodes", async () => {
    const res = await app.request("/api/episodes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { episodes: EpisodeListItem[] };
    expect(body.episodes.length).toBeGreaterThanOrEqual(2);
    // Each has messageCount
    expect(typeof body.episodes[0].messageCount).toBe("number");
  });

  it("GET /api/episodes/:episodeId/messages returns empty list for new episode", async () => {
    // Create a fresh episode
    const createRes = await app.request("/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Empty episode" }),
    });
    const { episode } = (await createRes.json()) as { episode: Episode };

    const res = await app.request(`/api/episodes/${episode.id}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it("GET /api/episodes/:episodeId/messages returns 404 for unknown episode", async () => {
    const res = await app.request(`/api/episodes/nonexistent-episode-id/messages`);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/episodes/:id removes the episode", async () => {
    // Create then delete
    const createRes = await app.request("/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To delete" }),
    });
    const { episode } = (await createRes.json()) as { episode: Episode };

    const delRes = await app.request(`/api/episodes/${episode.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // Verify gone
    const listRes = await app.request("/api/episodes");
    const { episodes } = (await listRes.json()) as { episodes: EpisodeListItem[] };
    expect(episodes.find((e) => e.id === episode.id)).toBeUndefined();
  });

  it("DELETE /api/episodes/:id returns 404 for unknown id", async () => {
    const res = await app.request(`/api/episodes/nonexistent-id`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/episodes/:id renames the episode", async () => {
    const createRes = await app.request("/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Old name" }),
    });
    const { episode } = (await createRes.json()) as { episode: Episode };

    const patchRes = await app.request(`/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New name" }),
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as { episode: Episode };
    expect(body.episode.title).toBe("New name");
  });
});
