/**
 * Chat route — POST /api/chat.
 *
 * Thin handler: zod validate → check episode exists → runChatPipeline (SSE).
 *
 * The response is an SSE stream of ChatEvent (see @lia/shared). The client
 * aborts by closing the connection — that triggers req.signal.aborted which
 * the pipeline checks to stop the LLM call.
 */

import { Hono } from "hono";
import { z } from "zod";
import { runChatPipeline } from "../chat/pipeline.js";
import { getEpisode } from "../services/episodes.js";

export const chatRoute = new Hono();

const chatSchema = z.object({
  text: z.string().trim().min(1).max(32_000),
  episodeId: z.string().trim().min(1).max(100),
  mode: z.enum(["chat", "agent", "research"]).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});

chatRoute.post("/", async (c) => {
  const parsed = chatSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const { text, episodeId, mode, attachmentIds } = parsed.data;

  const episode = getEpisode(episodeId);
  if (!episode) {
    return c.json({ error: "episode_not_found", episodeId }, 404);
  }

  // Hono exposes the raw Request signal via c.req.raw.signal — client
  // disconnect / Stop button propagates as abort.
  return runChatPipeline(c, {
    text,
    episodeId,
    mode: mode ?? "chat",
    attachmentIds,
    abortSignal: c.req.raw.signal,
  });
});
