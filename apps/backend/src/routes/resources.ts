/**
 * Resources routes — nested under episodes.
 *
 * GET    /api/episodes/:episodeId/resources          — list resources in episode + global
 * POST   /api/episodes/:episodeId/resources           — mount folder/codebase (JSON body)
 * POST   /api/episodes/:episodeId/resources/inline    — attach inline file (multipart upload)
 * GET    /api/resources/:id                            — get single resource
 * DELETE /api/resources/:id                            — delete resource
 * GET    /api/resources/:id/read                       — read resource content
 *
 * The /api/resources/:id routes are mounted at the top level (not under episodes)
 * because a resource id is globally unique.
 */

import { Hono } from "hono";
import { z } from "zod";
import * as workspace from "../workspace/service.js";
import { getEpisode } from "../services/episodes.js";
import { indexFolderResource, getIndexingStatus } from "../kb/indexer.js";
import { indexCodebaseResource } from "../code/indexer.js";
import { watchResource, unwatchResource } from "../kb/file-watcher.js";
import { logger } from "../util/logger.js";
import type {
  MountResourceRequest,
  Resource,
  ResourceKind,
  ResourceReadResponse,
} from "@lia/shared";

// ─── Episode-scoped routes (mounted at /api/episodes/:episodeId/resources) ──
export const episodeResourcesRoute = new Hono();

const mountSchema = z.object({
  kind: z.enum(["folder", "codebase"]),
  path: z.string().trim().min(1).max(2000),
  name: z.string().trim().max(200).optional(),
  watchEnabled: z.boolean().optional(),
  ignore: z.array(z.string()).optional(),
  languages: z
    .array(z.enum(["typescript", "javascript", "python", "go", "rust", "java"]))
    .optional(),
  license: z
    .enum([
      "MIT",
      "Apache-2.0",
      "BSD-3-Clause",
      "CC-BY-4.0",
      "CC-BY-SA-4.0",
      "CC-BY-NC-4.0",
      "Proprietary",
      "Unknown",
    ])
    .optional(),
  source: z.string().trim().max(2000).optional(),
  distributionAllowed: z.boolean().optional(),
});

// GET / — list resources in episode + global KB
episodeResourcesRoute.get("/", (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const existing = getEpisode(episodeId);
  if (!existing) return c.json({ error: "not_found", episodeId }, 404);

  const kindParam = c.req.query("kind");
  const statusParam = c.req.query("status");
  const includeGlobal = c.req.query("includeGlobal") !== "false";

  const opts: workspace.ListOpts = {
    includeGlobal,
  };
  if (kindParam) {
    const kinds = kindParam.split(",").filter(Boolean) as ResourceKind[];
    if (kinds.length > 0) opts.kind = kinds;
  }
  if (statusParam) {
    opts.status = statusParam as workspace.ListOpts["status"];
  }

  const result = workspace.list(episodeId, opts);
  return c.json({ resources: result satisfies Resource[] });
});

// POST / — mount folder/codebase
episodeResourcesRoute.post("/", async (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const existing = getEpisode(episodeId);
  if (!existing) return c.json({ error: "not_found", episodeId }, 404);

  const parsed = mountSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  try {
    const resource = await workspace.mount(episodeId, parsed.data satisfies MountResourceRequest);

    // M4: trigger background indexing for folder/codebase resources
    if (parsed.data.kind === "folder") {
      void indexFolderResource(resource.id)
        .then(() => {
          if (parsed.data.watchEnabled) {
            return watchResource(resource.id);
          }
        })
        .catch((e) =>
          logger.error({ err: e, resourceId: resource.id }, "background indexing failed"),
        );
    } else if (parsed.data.kind === "codebase") {
      // M6: codebase resources get symbol indexing (code symbols + references)
      void indexCodebaseResource(resource.id)
        .then(() => {
          if (parsed.data.watchEnabled) {
            return watchResource(resource.id);
          }
        })
        .catch((e) =>
          logger.error({ err: e, resourceId: resource.id }, "code indexing failed"),
        );
    }

    return c.json({ resource }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, episodeId }, "mount failed");
    return c.json({ error: "mount_failed", message: msg }, 400);
  }
});

// POST /inline — attach inline file (multipart upload)
episodeResourcesRoute.post("/inline", async (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const existing = getEpisode(episodeId);
  if (!existing) return c.json({ error: "not_found", episodeId }, 404);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "invalid_form_data" }, 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "missing_file", message: "formData must include a 'file' field" }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const resource = await workspace.attachInline({
      episodeId,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      buffer,
    });
    return c.json({ resource }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, episodeId, filename: file.name }, "attachInline failed");
    return c.json({ error: "attach_failed", message: msg }, 400);
  }
});

// ─── Top-level resource routes (mounted at /api/resources) ────────────
export const resourcesRoute = new Hono();

// GET /:id — get single resource
resourcesRoute.get("/:id", (c) => {
  const id = c.req.param("id");
  const resource = workspace.get(id);
  if (!resource) {
    return c.json({ error: "not_found", id }, 404);
  }
  return c.json({ resource });
});

// DELETE /:id — delete resource
resourcesRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await workspace.remove(id);
  if (!ok) {
    return c.json({ error: "not_found", id }, 404);
  }
  return c.json({ ok: true, id });
});

// GET /:id/read — read resource content
resourcesRoute.get("/:id/read", async (c) => {
  const id = c.req.param("id");
  const maxCharsParam = c.req.query("maxChars");
  const maxChars = maxCharsParam ? Number(maxCharsParam) : undefined;

  const result = await workspace.read(id, maxChars ? { maxChars } : {});
  if (!result) {
    return c.json({ error: "not_found", id }, 404);
  }
  return c.json(result satisfies ResourceReadResponse);
});

// POST /:id/reindex — manually trigger reindexing of a folder/codebase resource
resourcesRoute.post("/:id/reindex", async (c) => {
  const id = c.req.param("id");
  const resource = workspace.get(id);
  if (!resource) {
    return c.json({ error: "not_found", id }, 404);
  }
  if (resource.kind !== "folder" && resource.kind !== "codebase") {
    return c.json({ error: "not_indexable", message: "Only folder/codebase resources can be reindexed" }, 400);
  }

  // Run indexing in the background
  void indexFolderResource(id).catch((e) =>
    logger.error({ err: e, resourceId: id }, "manual reindex failed"),
  );

  return c.json({ ok: true, id, message: "reindexing started" });
});

// GET /:id/index-status — get indexing progress for a resource
resourcesRoute.get("/:id/index-status", (c) => {
  const id = c.req.param("id");
  const status = getIndexingStatus(id);
  return c.json(status);
});

// POST /:id/watch — start file watcher for a resource
resourcesRoute.post("/:id/watch", async (c) => {
  const id = c.req.param("id");
  const resource = workspace.get(id);
  if (!resource) {
    return c.json({ error: "not_found", id }, 404);
  }
  await watchResource(id);
  return c.json({ ok: true, id });
});

// DELETE /:id/watch — stop file watcher for a resource
resourcesRoute.delete("/:id/watch", async (c) => {
  const id = c.req.param("id");
  await unwatchResource(id);
  return c.json({ ok: true, id });
});
