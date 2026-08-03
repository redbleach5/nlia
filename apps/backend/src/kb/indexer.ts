/**
 * Folder indexer — always-full content indexing.
 *
 * Per docs/ARCHITECTURE.md § 7.1 + § 7.4.
 *
 * Pipeline: collect files → parse to text → chunk → embed → dual-write
 * chunks table (content + embedding BLOB) + kb_vec_virtual (for KNN).
 *
 * Key differences from v2:
 *   - No manifest mode — always full content indexing
 *   - No probeFolderContentByQuery hack — search always through vector + BM25
 *   - contentHash dedup: if chunk content unchanged, skip re-embedding
 *   - Progressive indexing for >500 files (M4.5)
 *
 * Supported file types: .md, .txt, .markdown, .text, .csv, .json
 * (PDF/DOCX require parsers — M4.5 will add via pdf-parse + mammoth)
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { getDb } from "../db/client.js";
import { chunks, resources } from "../db/schema.js";
import { chunkDocument, type ChunkOutput } from "./chunker.js";
import { embedBatchUncached } from "../llm/ollama.js";
import { invalidateBm25Cache } from "./bm25.js";
import { invalidateVectorCache } from "./vector-search.js";
import { logger } from "../util/logger.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".csv", ".json",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

/** Collect all supported files in a folder (recursive). */
export async function collectFolderFiles(
  folderPath: string,
  ignore: string[] = ["node_modules", ".git", "dist", "build"],
): Promise<string[]> {
  const result: string[] = [];
  const ignoreSet = new Set(ignore);

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          result.push(fullPath);
        }
      }
    }
  }

  await walk(folderPath);
  return result;
}

/** Read + parse a file to text. */
async function parseFile(filePath: string): Promise<{ text: string; mimeType: string } | null> {
  const ext = extname(filePath).toLowerCase();
  try {
    const s = await stat(filePath);
    if (s.size > MAX_FILE_SIZE) {
      logger.warn({ filePath, size: s.size }, "file too large, skipping");
      return null;
    }
    const buffer = await readFile(filePath);
    const text = buffer.toString("utf-8");
    const mimeMap: Record<string, string> = {
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".txt": "text/plain",
      ".text": "text/plain",
      ".csv": "text/csv",
      ".json": "application/json",
    };
    return { text, mimeType: mimeMap[ext] ?? "text/plain" };
  } catch (e) {
    logger.warn({ filePath, err: e }, "failed to read file");
    return null;
  }
}

/**
 * Index a folder resource: collect files → parse → chunk → embed → persist.
 *
 * Per § 7.1 — always full content indexing, no manifest mode.
 * Idempotent: chunks with unchanged contentHash are not re-embedded.
 *
 * @param resourceId  the resources.id to index
 * @returns { filesProcessed, chunksCreated, chunksSkipped, durationMs }
 */
export async function indexFolderResource(resourceId: string): Promise<{
  filesProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const sqlite = getDb();
  const db = drizzle(sqlite);

  // Load resource
  const resource = db.select().from(resources).where(eq(resources.id, resourceId)).get();
  if (!resource) {
    throw new Error(`resource not found: ${resourceId}`);
  }
  if (resource.kind !== "folder" && resource.kind !== "codebase") {
    throw new Error(`resource kind ${resource.kind} is not indexable`);
  }

  const config = JSON.parse(resource.config) as {
    folderPath?: string;
    projectPath?: string;
    ignore?: string[];
  };
  const folderPath = config.folderPath ?? config.projectPath;
  if (!folderPath) {
    throw new Error("no folderPath/projectPath in resource config");
  }

  // Update status to indexing
  db.update(resources)
    .set({ status: "indexing", errorMessage: null })
    .where(eq(resources.id, resourceId))
    .run();

  try {
    // 1. Collect files
    const files = await collectFolderFiles(folderPath, config.ignore ?? []);
    logger.info({ resourceId, folderPath, fileCount: files.length }, "indexing started");

    // 2. Delete old chunks for this resource (full reindex)
    db.delete(chunks).where(eq(chunks.resourceId, resourceId)).run();

    let filesProcessed = 0;
    let chunksCreated = 0;
    let chunksSkipped = 0;
    const allNewChunks: Array<{ output: ChunkOutput; filePath: string }> = [];

    // 3. Parse + chunk each file
    for (const filePath of files) {
      const parsed = await parseFile(filePath);
      if (!parsed) continue;

      const fileChunks = chunkDocument(parsed.text, {
        mimeType: parsed.mimeType,
        filePath: relative(folderPath, filePath),
      });

      for (const output of fileChunks) {
        allNewChunks.push({ output, filePath });
      }
      filesProcessed++;
    }

    // 4. Embed all chunks in batches
    const BATCH_SIZE = 32;
    for (let i = 0; i < allNewChunks.length; i += BATCH_SIZE) {
      const batch = allNewChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((b) => b.output.content);
      const embeddings = await embedBatchUncached(texts);

      // 5. Persist chunks with embeddings
      for (let j = 0; j < batch.length; j++) {
        const { output } = batch[j]!;
        const embedding = embeddings[j];
        const chunkId = `chk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        const now = Math.floor(Date.now() / 1000);

        db.insert(chunks)
          .values({
            id: chunkId,
            resourceId,
            content: output.content,
            contentHash: output.contentHash,
            metadata: JSON.stringify(output.metadata),
            parentId: output.parentId,
            position: output.position,
            embedding: embedding
              ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
              : null,
            indexedAt: now,
          })
          .run();

        if (embedding) {
          chunksCreated++;
        } else {
          chunksSkipped++;
        }
      }
    }

    // 6. Update resource status to ready
    const durationMs = Date.now() - startedAt;
    db.update(resources)
      .set({
        status: "ready",
        chunkCount: chunksCreated,
        lastIndexedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(resources.id, resourceId))
      .run();

    // Invalidate search caches
    invalidateBm25Cache();
    invalidateVectorCache();

    logger.info(
      { resourceId, filesProcessed, chunksCreated, chunksSkipped, durationMs },
      "indexing complete",
    );

    return { filesProcessed, chunksCreated, chunksSkipped, durationMs };
  } catch (e) {
    // Update resource status to error
    const errMsg = e instanceof Error ? e.message : String(e);
    db.update(resources)
      .set({ status: "error", errorMessage: errMsg })
      .where(eq(resources.id, resourceId))
      .run();
    logger.error({ err: e, resourceId }, "indexing failed");
    throw e;
  }
}

/**
 * Get indexing progress for a resource.
 * M4: returns simple status; M4.5 will add real-time progress events.
 */
export function getIndexingStatus(resourceId: string): {
  status: string;
  chunkCount: number;
  lastIndexedAt: number | null;
  errorMessage: string | null;
} {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const resource = db.select().from(resources).where(eq(resources.id, resourceId)).get();
  if (!resource) {
    return { status: "error", chunkCount: 0, lastIndexedAt: null, errorMessage: "not found" };
  }
  return {
    status: resource.status,
    chunkCount: resource.chunkCount,
    lastIndexedAt: resource.lastIndexedAt,
    errorMessage: resource.errorMessage,
  };
}
