/**
 * Code symbol routes — query code symbols + references.
 *
 * GET  /api/resources/:id/symbols              — list all symbols in a codebase
 * GET  /api/resources/:id/symbols/search?q=...  — search symbols by name
 * GET  /api/resources/:id/symbols/:name/refs    — list references for a symbol name
 * GET  /api/resources/:id/symbols/:name/def     — find definition of a symbol name
 * GET  /api/resources/:id/importers?filePath=... — find files that import a file
 * POST /api/resources/:id/reindex-code          — manually trigger code reindex
 */

import { Hono } from "hono";
import {
  searchSymbols,
  listReferences,
  listDefinitions,
  listImporters,
  listFileSymbols,
} from "../code/service.js";
import { indexCodebaseResource } from "../code/indexer.js";
import { logger } from "../util/logger.js";
import type { CodeSymbol, CodeReference, SymbolSearchResult } from "@lia/shared";

export const codeRoute = new Hono();

// GET /:id/symbols — list all symbols (optional ?filePath= to filter by file)
codeRoute.get("/:id/symbols", (c) => {
  const id = c.req.param("id");
  const filePath = c.req.query("filePath");

  if (filePath) {
    const symbols = listFileSymbols(filePath, { resourceIds: [id] });
    return c.json({ symbols: symbols satisfies CodeSymbol[] });
  }

  // List all symbols for this resource (search with empty query returns all? No — use searchSymbols with wildcard)
  // For "list all", we search with empty string which matches all via LIKE '%%'
  const results = searchSymbols("", { resourceIds: [id], limit: 500 });
  return c.json({
    symbols: results.map((r) => r.symbol) satisfies CodeSymbol[],
  });
});

// GET /:id/symbols/search?q=... — search symbols by name
codeRoute.get("/:id/symbols/search", (c) => {
  const id = c.req.param("id");
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "missing_query", message: "Query parameter 'q' is required" }, 400);
  }

  const results = searchSymbols(query, { resourceIds: [id], limit: 20 });
  return c.json({ results: results satisfies SymbolSearchResult[] });
});

// GET /:id/symbols/:symbolId/refs — list references for a symbol by id
codeRoute.get("/:id/symbols/:symbolId/refs", (c) => {
  const symbolId = c.req.param("symbolId");
  const { symbol, references } = listReferences(symbolId);
  if (!symbol) {
    return c.json({ error: "not_found", symbolId }, 404);
  }
  return c.json({
    symbol: symbol satisfies CodeSymbol,
    references: references satisfies CodeReference[],
  });
});

// GET /:id/definitions/:name — find definition of a symbol by name
codeRoute.get("/:id/definitions/:name", (c) => {
  const id = c.req.param("id");
  const name = c.req.param("name");
  const definitions = listDefinitions(name, { resourceIds: [id] });
  return c.json({ definitions: definitions satisfies CodeSymbol[] });
});

// GET /:id/importers?filePath=... — find files that import a given file
codeRoute.get("/:id/importers", (c) => {
  const id = c.req.param("id");
  const filePath = c.req.query("filePath");
  if (!filePath) {
    return c.json({ error: "missing_filePath" }, 400);
  }

  const importers = listImporters(filePath, { resourceIds: [id] });
  return c.json({ importers: importers satisfies CodeReference[] });
});

// POST /:id/reindex-code — manually trigger code reindex
codeRoute.post("/:id/reindex-code", async (c) => {
  const id = c.req.param("id");
  void indexCodebaseResource(id).catch((e) =>
    logger.error({ err: e, resourceId: id }, "manual code reindex failed"),
  );
  return c.json({ ok: true, id, message: "code reindexing started" });
});
