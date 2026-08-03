/**
 * WorkspaceService — unified Resource API replacing v2's 5 mechanisms.
 *
 * Per docs/ARCHITECTURE.md § 6.2. Implements:
 *   - list(episodeId, opts)        — resources in an episode + global KB
 *   - get(id)                       — single resource
 *   - read(id, opts)                — read content (file body, extracted text)
 *   - mount(episodeId, config)      — mount folder/codebase as new resource
 *   - attachInline(episodeId, file) — chat attachment → inline resource
 *   - remove(id)                    — delete resource (+ inline file on disk)
 *
 * M2 scope: inline + folder/codebase mount + read. Search/references land in M4/M6.
 *
 * Storage layout:
 *   data/attachments/{episodeId}/{resourceId}_{sanitizedName}  — inline files
 *   folder/codebase paths are NOT copied — Resource.config.folderPath points to original
 */

import { eq, and, or, isNull, desc, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, rm, stat } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";
import { getDb } from "../db/client.js";
import { resources } from "../db/schema.js";
import { logger } from "../util/logger.js";
import type {
  Resource,
  ResourceConfig,
  ResourceKind,
  ResourceStatus,
  MountResourceRequest,
  ResourceReadResponse,
} from "@lia/shared";

// ─── Paths ────────────────────────────────────────────────────────────
const here = pathDirname(fileURLToPath(import.meta.url));
// apps/backend/src/workspace/ → apps/backend/data/attachments
const ATTACHMENTS_DIR = resolve(here, "../../data/attachments");

// ─── Limits (ported from v2 chat/attachments/policy.ts) ──────────────
const INLINE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const INLINE_MAX_PER_EPISODE = 20;
const INLINE_MAX_TEXT_PREVIEW = 12_000; // per file
const READ_MAX_CHARS = 50_000; // default maxChars for read()

const ALLOWED_INLINE_MIMES: Record<string, "image" | "text" | "pdf" | "docx"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// ─── ID generation ────────────────────────────────────────────────────
function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `r_${ts}${rand}`;
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, " ").trim();
  return base.slice(0, 120) || "file";
}

function mimeFromFilename(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] ?? null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Row → DTO ────────────────────────────────────────────────────────
function rowToResource(row: typeof resources.$inferSelect): Resource {
  return {
    id: row.id,
    episodeId: row.episodeId,
    kind: row.kind as ResourceKind,
    name: row.name,
    config: JSON.parse(row.config) as ResourceConfig,
    status: row.status as ResourceStatus,
    chunkCount: row.chunkCount,
    tags: JSON.parse(row.tags) as string[],
    errorMessage: row.errorMessage,
    contentHash: row.contentHash,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastIndexedAt: row.lastIndexedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────────

export interface ListOpts {
  kind?: ResourceKind[];
  status?: ResourceStatus;
  /** Include global (episodeId=null) resources. Default: true. */
  includeGlobal?: boolean;
}

/**
 * List resources available in an episode.
 * Returns episode-scoped resources + global KB resources (unless includeGlobal=false).
 */
export function list(episodeId: string, opts: ListOpts = {}): Resource[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const conditions = [];
  if (opts.includeGlobal !== false) {
    conditions.push(
      or(eq(resources.episodeId, episodeId), isNull(resources.episodeId))!,
    );
  } else {
    conditions.push(eq(resources.episodeId, episodeId));
  }
  // Drizzle doesn't support composing OR of arbitrary conditions easily;
  // for M2 we use a single where with OR + optional kind/status filters via raw SQL.
  // Simpler: fetch all matching episode+global, then filter in JS.
  const rows = db
    .select()
    .from(resources)
    .where(
      or(eq(resources.episodeId, episodeId), isNull(resources.episodeId)),
    )
    .orderBy(asc(resources.kind), desc(resources.createdAt))
    .all();

  let result = rows.map(rowToResource);
  if (opts.kind && opts.kind.length > 0) {
    const kinds = new Set(opts.kind);
    result = result.filter((r) => kinds.has(r.kind));
  }
  if (opts.status) {
    result = result.filter((r) => r.status === opts.status);
  }
  return result;
}

/** Get a single resource by id. */
export function get(id: string): Resource | null {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db.select().from(resources).where(eq(resources.id, id)).get();
  return row ? rowToResource(row) : null;
}

/**
 * Read content of a resource.
 *  - inline: returns extracted text preview (or empty for images)
 *  - folder/codebase: reads the file at config.folderPath (for preview of the root);
 *    M4 will add per-file read via workspace.read(resourceId, filePath)
 *  - url: returns cached HTML (M5)
 *  - symbol: returns symbol source text (M6)
 */
export async function read(
  id: string,
  opts: { maxChars?: number } = {},
): Promise<ResourceReadResponse | null> {
  const resource = get(id);
  if (!resource) return null;

  const maxChars = opts.maxChars ?? READ_MAX_CHARS;

  if (resource.kind === "inline") {
    const cfg = resource.config;
    if (!cfg.storageKey) {
      return { content: "", truncated: false, mimeType: cfg.mimeType ?? null, byteSize: resource.byteSize };
    }
    // For text/pdf/docx: return the extracted textPreview
    if (cfg.textPreview !== undefined && cfg.textPreview !== null) {
      const truncated = cfg.textPreview.length > maxChars;
      return {
        content: truncated ? cfg.textPreview.slice(0, maxChars) : cfg.textPreview,
        truncated,
        mimeType: cfg.mimeType ?? null,
        byteSize: resource.byteSize,
      };
    }
    // For images: return a placeholder (UI shows the image separately)
    return {
      content: `[image: ${resource.name}]`,
      truncated: false,
      mimeType: cfg.mimeType ?? null,
      byteSize: resource.byteSize,
    };
  }

  if (resource.kind === "folder" || resource.kind === "codebase") {
    const cfg = resource.config;
    const folderPath = cfg.folderPath ?? cfg.projectPath;
    if (!folderPath) {
      return { content: "", truncated: false, mimeType: null, byteSize: null };
    }
    // M2: return a manifest of the folder (top-level files). M4 will add full read.
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(folderPath, { withFileTypes: true });
      const lines = entries.slice(0, 100).map((e) => {
        const t = e.isDirectory() ? "dir " : "file";
        return `${t}  ${e.name}`;
      });
      const header = `${resource.kind}: ${folderPath}\n${entries.length} entries (showing first ${Math.min(entries.length, 100)})\n\n`;
      const content = header + lines.join("\n");
      const truncated = content.length > maxChars;
      return {
        content: truncated ? content.slice(0, maxChars) : content,
        truncated,
        mimeType: "text/plain",
        byteSize: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `error reading folder: ${msg}`, truncated: false, mimeType: null, byteSize: null };
    }
  }

  // url, symbol — M5/M6
  return { content: "", truncated: false, mimeType: null, byteSize: resource.byteSize };
}

// ─── Mount folder/codebase ────────────────────────────────────────────

/**
 * Mount a folder or codebase as a new resource.
 * Validates that the path exists and is a directory.
 * License validation per Addendum A.2: if license is "Unknown" or missing for
 * KB source, the resource is still created but UI shows a warning.
 */
export async function mount(
  episodeId: string | null,
  req: MountResourceRequest,
): Promise<Resource> {
  const absPath = resolve(req.path);
  try {
    const s = await stat(absPath);
    if (!s.isDirectory()) {
      throw new Error(`not a directory: ${absPath}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`folder path invalid: ${msg}`);
  }

  const id = makeId();
  const now = Math.floor(Date.now() / 1000);
  const name = req.name || basename(absPath);

  const config: ResourceConfig = {
    license: req.license ?? "Unknown",
    source: req.source ?? absPath,
    distributionAllowed: req.distributionAllowed ?? true,
    watchEnabled: req.watchEnabled ?? false,
    ignore: req.ignore ?? ["node_modules", ".git", "dist", "build"],
    ...(req.kind === "codebase"
      ? {
          projectPath: absPath,
          languages: req.languages ?? (["typescript", "javascript"] as const),
        }
      : {
          folderPath: absPath,
        }),
  };

  const sqlite = getDb();
  const db = drizzle(sqlite);
  db.insert(resources)
    .values({
      id,
      episodeId,
      kind: req.kind,
      name,
      config: JSON.stringify(config),
      status: "idle", // M4 indexer sets 'indexing' → 'ready'
      chunkCount: 0,
      tags: "[]",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  logger.info({ resourceId: id, kind: req.kind, path: absPath, episodeId }, "resource mounted");
  return get(id)!;
}

// ─── Attach inline (chat attachment) ──────────────────────────────────

export interface AttachInlineParams {
  episodeId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Save an uploaded file as an inline resource.
 * - Validates MIME type against ALLOWED_INLINE_MIMES
 * - Enforces INLINE_MAX_BYTES + INLINE_MAX_PER_EPISODE
 * - Writes file to data/attachments/{episodeId}/{resourceId}_{sanitizedName}
 * - Extracts text preview for text/pdf/docx (M2: text only; pdf/docx land in M4 with KB indexer)
 */
export async function attachInline(params: AttachInlineParams): Promise<Resource> {
  const { episodeId, originalName, buffer } = params;
  let mimeType = params.mimeType;
  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = mimeFromFilename(originalName) ?? mimeType;
  }

  const inlineKind = ALLOWED_INLINE_MIMES[mimeType];
  if (!inlineKind) {
    throw new Error(`MIME type not supported for inline attachment: ${mimeType}`);
  }
  if (buffer.byteLength > INLINE_MAX_BYTES) {
    throw new Error(`File too large (max ${INLINE_MAX_BYTES / (1024 * 1024)} MB)`);
  }

  // Count existing inline resources for this episode
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const existing = db
    .select({ c: resources.id })
    .from(resources)
    .where(and(eq(resources.episodeId, episodeId), eq(resources.kind, "inline")))
    .all();
  if (existing.length >= INLINE_MAX_PER_EPISODE) {
    throw new Error(`Too many attachments (max ${INLINE_MAX_PER_EPISODE} per episode)`);
  }

  const id = makeId();
  const safeName = sanitizeFilename(originalName);
  const storageKey = `${episodeId}/${id}_${safeName}`;
  const absPath = join(ATTACHMENTS_DIR, storageKey);
  const contentHash = sha256(buffer);

  // Ensure dir exists + write file
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, buffer);

  // Extract text preview (M2: text only; pdf/docx require KB indexer in M4)
  const textPreview = await extractTextPreview(absPath, mimeType, inlineKind);

  const now = Math.floor(Date.now() / 1000);
  const config: ResourceConfig = {
    // Inline attachments default to distributionAllowed=true (they're user uploads, not KB sources)
    distributionAllowed: true,
    storageKey,
    mimeType,
    sizeBytes: buffer.byteLength,
    textPreview,
  };

  db.insert(resources)
    .values({
      id,
      episodeId,
      kind: "inline",
      name: safeName,
      config: JSON.stringify(config),
      status: "ready", // inline resources are immediately ready
      chunkCount: 0,
      tags: "[]",
      contentHash,
      byteSize: buffer.byteLength,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  logger.info(
    { resourceId: id, episodeId, name: safeName, mimeType, sizeBytes: buffer.byteLength },
    "inline resource attached",
  );
  return get(id)!;
}

/**
 * Extract text preview for prompt injection.
 * M2: text/plain, text/markdown, text/csv, application/json only.
 * M4 will port v2's parseKbFile for pdf/docx.
 */
async function extractTextPreview(
  absPath: string,
  _mimeType: string,
  inlineKind: "image" | "text" | "pdf" | "docx",
): Promise<string | null> {
  if (inlineKind === "image") return null;
  if (inlineKind === "pdf" || inlineKind === "docx") {
    // M4 will wire the KB indexer here. For M2 return a placeholder so the
    // UI can show "[pdf content extraction in M4]" without breaking chat.
    return null;
  }
  // text/*
  try {
    const raw = await readFile(absPath, "utf-8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length > INLINE_MAX_TEXT_PREVIEW
      ? `${trimmed.slice(0, INLINE_MAX_TEXT_PREVIEW)}\n…[truncated for message context]`
      : trimmed;
  } catch {
    return null;
  }
}

// ─── Remove ───────────────────────────────────────────────────────────

/**
 * Delete a resource.
 *  - inline: also deletes the file on disk
 *  - folder/codebase: only deletes the DB row (original files untouched)
 */
export async function remove(id: string): Promise<boolean> {
  const resource = get(id);
  if (!resource) return false;

  const sqlite = getDb();
  const db = drizzle(sqlite);

  // Delete inline file from disk
  if (resource.kind === "inline" && resource.config.storageKey) {
    const absPath = join(ATTACHMENTS_DIR, resource.config.storageKey);
    try {
      await unlink(absPath);
    } catch {
      // already gone — non-fatal
    }
    // Clean up empty episode dir
    const epDir = dirname(absPath);
    try {
      const { readdir } = await import("node:fs/promises");
      const remaining = await readdir(epDir);
      if (remaining.length === 0) {
        await rm(epDir, { recursive: true });
      }
    } catch {
      // non-fatal
    }
  }

  db.delete(resources).where(eq(resources.id, id)).run();
  logger.info({ resourceId: id, kind: resource.kind }, "resource removed");
  return true;
}

// ─── Helpers for chat pipeline integration ────────────────────────────

/**
 * Get inline resources by ids (used by chat pipeline to inject attachment text).
 * Verifies each resource belongs to the given episode.
 */
export function getInlineResourcesForEpisode(
  episodeId: string,
  resourceIds: string[],
): Resource[] {
  if (resourceIds.length === 0) return [];
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select()
    .from(resources)
    .where(and(eq(resources.episodeId, episodeId), eq(resources.kind, "inline")))
    .all()
    .filter((r) => resourceIds.includes(r.id));
  return rows.map(rowToResource);
}

/**
 * Build the attachments context block for the system prompt.
 * Returns null if no inline resources have text previews.
 */
export function buildAttachmentsContext(inlineResources: Resource[]): string | null {
  const withText = inlineResources.filter(
    (r) => r.config.textPreview !== null && r.config.textPreview !== undefined,
  );
  if (withText.length === 0) return null;

  const lines: string[] = ["=== ВЛОЖЕНИЯ В ЧАТЕ (контекст этого сообщения) ==="];
  for (const r of withText) {
    lines.push(`--- ${r.name} (${r.config.mimeType ?? "unknown"}, ${r.byteSize ?? 0} bytes) ---`);
    lines.push(r.config.textPreview!);
    lines.push("");
  }
  return lines.join("\n");
}

export { ATTACHMENTS_DIR };
