/**
 * File watcher — auto-reindex on file changes.
 *
 * Per docs/ARCHITECTURE.md § 7.1 — chokidar for folder watching.
 * Watches folder/codebase resources and triggers reindex on change.
 *
 * M4: basic watch + debounce. M4.5 will add incremental reindex (only
 * changed files, not full reindex).
 */

import chokidar, { type FSWatcher } from "chokidar";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { resources } from "../db/schema.js";
import { indexFolderResource } from "./indexer.js";
import { logger } from "../util/logger.js";

const REINDEX_DEBOUNCE_MS = 2000;

interface WatchEntry {
  watcher: FSWatcher;
  resourceId: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, WatchEntry>();

/**
 * Start watching a folder/codebase resource for changes.
 * Debounces rapid changes (editor save storms) before triggering reindex.
 */
export async function watchResource(resourceId: string): Promise<void> {
  // Stop existing watcher for this resource
  await unwatchResource(resourceId);

  const sqlite = getDb();
  const db = drizzle(sqlite);
  const resource = db.select().from(resources).where(eq(resources.id, resourceId)).get();
  if (!resource) {
    logger.warn({ resourceId }, "watchResource: not found");
    return;
  }

  const config = JSON.parse(resource.config) as {
    folderPath?: string;
    projectPath?: string;
    watchEnabled?: boolean;
    ignore?: string[];
  };

  if (!config.watchEnabled) {
    return; // watching disabled for this resource
  }

  const folderPath = config.folderPath ?? config.projectPath;
  if (!folderPath) return;

  const ignore = config.ignore ?? ["node_modules", ".git", "dist", "build"];
  const ignoredPaths = ignore.map((p) => `**/${p}/**`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = chokidar.watch(folderPath, {
    ignored: ignoredPaths,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const triggerReindex = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      logger.info({ resourceId }, "file change detected, reindexing");
      void indexFolderResource(resourceId).catch((e) =>
        logger.error({ err: e, resourceId }, "auto-reindex failed"),
      );
    }, REINDEX_DEBOUNCE_MS);
  };

  watcher.on("change", triggerReindex);
  watcher.on("add", triggerReindex);
  watcher.on("unlink", triggerReindex);

  watchers.set(resourceId, { watcher, resourceId, debounceTimer: null });
  logger.info({ resourceId, folderPath }, "file watcher started");
}

/**
 * Stop watching a resource.
 */
export async function unwatchResource(resourceId: string): Promise<void> {
  const entry = watchers.get(resourceId);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  await entry.watcher.close();
  watchers.delete(resourceId);
  logger.info({ resourceId }, "file watcher stopped");
}

/**
 * Stop all watchers (on shutdown).
 */
export async function unwatchAll(): Promise<void> {
  const ids = Array.from(watchers.keys());
  await Promise.all(ids.map((id) => unwatchResource(id)));
}
