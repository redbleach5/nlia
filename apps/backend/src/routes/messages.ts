/**
 * Messages routes.
 *
 * GET /api/episodes/:id/messages — list messages in episode (oldest first)
 */

import { Hono } from "hono";
import { listMessages } from "../services/messages.js";
import { getEpisode } from "../services/episodes.js";
import type { Message } from "@lia/shared";

export const messagesRoute = new Hono();

messagesRoute.get("/", (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) {
    return c.json({ error: "missing_episodeId" }, 400);
  }
  const existing = getEpisode(episodeId);
  if (!existing) {
    return c.json({ error: "not_found", episodeId }, 404);
  }
  const msgs = listMessages(episodeId, 500);
  return c.json({ messages: msgs satisfies Message[] });
});
