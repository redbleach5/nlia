/**
 * Lia v3 backend — Hono app composition root.
 *
 * M1 routes wired:
 *   GET    /api/health                 — M0 stack validation
 *   GET    /api/capability             — Ollama health + effective model slots
 *   GET    /api/settings               — model slots
 *   PUT    /api/settings               — update model slots
 *   GET    /api/episodes               — list
 *   POST   /api/episodes               — create
 *   POST   /api/episodes/ensure-default — atomic first-episode create
 *   DELETE /api/episodes/:id           — delete
 *   PATCH  /api/episodes/:id           — rename
 *   GET    /api/episodes/:episodeId/messages — list messages
 *   POST   /api/chat                   — SSE chat pipeline
 *
 * M2+ adds: /api/workspace, /api/resources. M5 adds /api/agent/*.
 */

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { capabilityRoute } from "./routes/capability.js";
import { settingsRoute } from "./routes/settings.js";
import { episodesRoute } from "./routes/episodes.js";
import { messagesRoute } from "./routes/messages.js";
import { chatRoute } from "./routes/chat.js";
import { episodeResourcesRoute, resourcesRoute } from "./routes/resources.js";
import { memoryRoute } from "./routes/memory.js";
import { searchRoute } from "./routes/search.js";
import { agentRoute } from "./routes/agent.js";
import { codeRoute } from "./routes/code.js";
import { vrmRoute } from "./routes/vrm.js";
import { logger as pinoLogger } from "./util/logger.js";

export const app = new Hono();

app.use("*", honoLogger());
app.use(
  "*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173", "tauri://localhost"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
  }),
);

app.route("/api/health", healthRoute);
app.route("/api/capability", capabilityRoute);
app.route("/api/settings", settingsRoute);

app.route("/api/episodes", episodesRoute);
// Messages are nested under episodes: /api/episodes/:episodeId/messages
app.route("/api/episodes/:episodeId/messages", messagesRoute);
// Resources are nested under episodes: /api/episodes/:episodeId/resources
// (plus top-level /api/resources/:id for get/delete/read by id)
app.route("/api/episodes/:episodeId/resources", episodeResourcesRoute);
app.route("/api/resources", resourcesRoute);
app.route("/api", memoryRoute);
app.route("/api/episodes/:episodeId/search", searchRoute);
app.route("/api/agent", agentRoute);
app.route("/api/resources", codeRoute);
app.route("/api/settings/vrm", vrmRoute);

app.route("/api/chat", chatRoute);

app.get("/api", (c) =>
  c.json({
    name: "lia-backend",
    version: "0.1.0",
    routes: [
      "/api/health",
      "/api/capability",
      "/api/settings",
      "/api/episodes",
      "/api/episodes/ensure-default",
      "/api/episodes/:id",
      "/api/episodes/:episodeId/messages",
      "/api/episodes/:episodeId/resources",
      "/api/episodes/:episodeId/facts",
      "/api/episodes/:episodeId/memories",
      "/api/episodes/:episodeId/decisions",
      "/api/episodes/:episodeId/reflect",
      "/api/global-facts",
      "/api/resources/:id",
      "/api/resources/:id/read",
      "/api/chat",
    ],
  }),
);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  pinoLogger.error({ err, path: c.req.path }, "unhandled error");
  return c.json({ error: "internal", message: String(err) }, 500);
});

export default app;
