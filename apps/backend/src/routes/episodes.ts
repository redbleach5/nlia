/**
 * Episodes routes.
 *
 * GET    /api/episodes              — list (most-recently-active first)
 * POST   /api/episodes              — create new
 * POST   /api/episodes/ensure-default — atomically create first if none
 * DELETE /api/episodes/:id          — delete (cascades to messages/facts/memories)
 * PATCH  /api/episodes/:id          — rename
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  listEpisodes,
  createEpisode,
  ensureDefaultEpisode,
  deleteEpisode,
  renameEpisode,
  getEpisode,
} from "../services/episodes.js";
import { logger } from "../util/logger.js";
import type { EnsureDefaultResponse, EpisodeListItem } from "@lia/shared";

export const episodesRoute = new Hono();

const createSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  mode: z.enum(["chat", "agent", "research"]).optional(),
});

const renameSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

episodesRoute.get("/", (c) => {
  const episodes = listEpisodes(500);
  return c.json({ episodes: episodes satisfies EpisodeListItem[] });
});

episodesRoute.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const episode = createEpisode({
    title: parsed.data.title ?? null,
    mode: parsed.data.mode ?? "chat",
    isDefault: false,
  });
  return c.json({ episode }, 201);
});

episodesRoute.post("/ensure-default", (c) => {
  const result = ensureDefaultEpisode();
  return c.json(result satisfies EnsureDefaultResponse);
});

/** Delete all episodes except optional keepId (defaults to most recent). */
episodesRoute.post("/clear", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { keepId?: string };
  const all = listEpisodes(2000);
  const keepId = body.keepId && all.some((e) => e.id === body.keepId)
    ? body.keepId
    : all[0]?.id;
  let deleted = 0;
  for (const ep of all) {
    if (ep.id === keepId) continue;
    if (deleteEpisode(ep.id)) deleted += 1;
  }
  logger.info({ deleted, keepId }, "episodes cleared");
  return c.json({ ok: true, deleted, keepId, episodes: listEpisodes(500) });
});

episodesRoute.delete("/:id", (c) => {
  const id = c.req.param("id");
  const ok = deleteEpisode(id);
  if (!ok) {
    return c.json({ error: "not_found", id }, 404);
  }
  logger.info({ episodeId: id }, "episode deleted");
  return c.json({ ok: true, id });
});

episodesRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = renameSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const existing = getEpisode(id);
  if (!existing) {
    return c.json({ error: "not_found", id }, 404);
  }
  const updated = renameEpisode(id, parsed.data.title);
  return c.json({ episode: updated });
});
