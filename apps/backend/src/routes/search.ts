/**
 * KB search route — hybrid search across episode + global resources.
 *
 * GET /api/episodes/:episodeId/search?q=...
 *   ?q=query           — search query (required)
 *   ?limit=10          — max results
 *   ?reranker=true     — enable cross-encoder reranker
 *   ?multiQuery=true   — enable multi-query expansion
 *   ?hyde=true         — enable HyDE
 *   ?mmr=true          — enable MMR diversification (default true)
 *   ?resourceIds=...   — comma-separated resource ids to scope
 */

import { Hono } from "hono";
import { hybridSearch } from "../kb/search.js";
import { getEpisode } from "../services/episodes.js";
import type { SearchResponse } from "@lia/shared";

export const searchRoute = new Hono();

searchRoute.get("/", async (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const existing = getEpisode(episodeId);
  if (!existing) return c.json({ error: "not_found", episodeId }, 404);

  const query = c.req.query("q");
  if (!query || query.trim().length === 0) {
    return c.json({ error: "missing_query", message: "Query parameter 'q' is required" }, 400);
  }

  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 10;
  const reranker = c.req.query("reranker") === "true";
  const multiQuery = c.req.query("multiQuery") === "true";
  const hyde = c.req.query("hyde") === "true";
  const mmr = c.req.query("mmr") !== "false"; // default true
  const resourceIdsParam = c.req.query("resourceIds");
  const resourceIds = resourceIdsParam
    ? resourceIdsParam.split(",").filter(Boolean)
    : undefined;

  const result = await hybridSearch(episodeId, query, {
    limit,
    reranker,
    multiQuery,
    hyde,
    mmr,
    resourceIds,
  });

  return c.json(result satisfies SearchResponse);
});
