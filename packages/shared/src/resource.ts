/**
 * Unified Resource model — see docs/ARCHITECTURE.md § 5.2 (Resource table) + § 6.
 *
 * Replaces v2's 5 parallel mechanisms (chat attachment, KB folder, KB codebase,
 * agent fsScope, @mention) with a single Resource entity scoped to an Episode.
 *
 * M2: full DB-backed type matching the `resources` table. Used by:
 *   - backend WorkspaceService (CRUD)
 *   - backend routes (serialise to JSON)
 *   - frontend workspace store + UI panel
 */

export type ResourceKind = "inline" | "folder" | "codebase" | "symbol" | "url";

export type ResourceStatus = "idle" | "indexing" | "ready" | "error";

export type ResourceLicense =
  | "MIT"
  | "Apache-2.0"
  | "BSD-3-Clause"
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | "CC-BY-NC-4.0"
  | "Proprietary"
  | "Unknown";

/** Kind-specific config payload stored as JSON in Resource.config. */
export interface ResourceConfig {
  // ─── Common (Addendum A.2 — license hygiene for KB sources) ────────
  /** SPDX-style license identifier — required for folder/codebase/url; optional for inline. */
  license?: ResourceLicense;
  /** URL or local path the asset was obtained from. */
  source?: string;
  /** If false, asset may be indexed but NOT redistributed in Lia-built artifacts. */
  distributionAllowed?: boolean;

  // ─── inline (chat attachment) ──────────────────────────────────────
  /** Relative to data/attachments/ — e.g. "{episodeId}/{resourceId}_{filename}". */
  storageKey?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Extracted text preview for prompt injection (text/pdf/docx; null for images). */
  textPreview?: string | null;

  // ─── folder / codebase ─────────────────────────────────────────────
  folderPath?: string;
  projectPath?: string;
  watchEnabled?: boolean;
  fileHashes?: Record<string, string>;
  /** Glob ignore patterns. */
  ignore?: string[];
  /** Codebase only: languages to parse with Tree-sitter. */
  languages?: ("typescript" | "javascript" | "python" | "go" | "rust" | "java")[];

  // ─── url (web cache) ───────────────────────────────────────────────
  url?: string;
  lastFetchedAt?: number;

  // ─── symbol (code reference — M6) ──────────────────────────────────
  symbolId?: string;
  parentResourceId?: string;
}

/** Resource row as returned by the API. Mirrors the DB row with parsed config. */
export interface Resource {
  id: string;
  /** null = global (KB source persistent across episodes); set = scoped to episode. */
  episodeId: string | null;
  kind: ResourceKind;
  name: string;
  config: ResourceConfig;
  status: ResourceStatus;
  chunkCount: number;
  tags: string[];
  errorMessage: string | null;
  contentHash: string | null;
  byteSize: number | null;
  createdAt: number;
  updatedAt: number;
  lastIndexedAt: number | null;
}

/** Request body for POST /api/episodes/:episodeId/resources (mount folder/codebase). */
export interface MountResourceRequest {
  kind: "folder" | "codebase";
  path: string;
  name?: string;
  watchEnabled?: boolean;
  ignore?: string[];
  languages?: ResourceConfig["languages"];
  license?: ResourceLicense;
  source?: string;
  distributionAllowed?: boolean;
}

/** Response from attachInline (multipart upload). */
export interface AttachInlineResponse {
  resource: Resource;
}

/** Response from GET /api/resources/:id/read. */
export interface ResourceReadResponse {
  content: string;
  truncated: boolean;
  mimeType: string | null;
  byteSize: number | null;
}
