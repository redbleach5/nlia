/**
 * Drizzle schema for Lia v3.
 *
 * M1 scope: full chat data model ported from v2 prisma/schema.prisma per
 * docs/ARCHITECTURE.md § 5.1, § 5.3, § 9, § 10.
 *
 * Tables (M1):
 *   - schemaMeta          — versioning (kept from M0)
 *   - settings            — key/value store (model slots, identity, ui)
 *   - episodes            — chat conversations
 *   - messages            — all roles in one table (user/companion/tool/system)
 *   - episodeFacts        — per-episode context facts
 *   - globalFacts         — cross-episode user profile
 *   - emotionalMemories   — significant emotional moments
 *   - vectorMemory        — semantic search index per episode (BLOB embedding)
 *
 * Tables (M2):
 *   - resources             — unified Resource abstraction (replaces v2's 5 mechanisms)
 *
 * Tables (M3):
 *   - decisions              — model reasoning trace (new layer per § 5.3)
 *
 * Tables (M4):
 *   - chunks                 — KB content chunks (full content indexing per § 7.1)
 *
 * Tables (M5):
 *   - agentTasks              — agent tasks for model-driven orchestration (§ 5.5)
 *
 * Tables (M6):
 *   - codeSymbols, codeReferences  — symbol-aware code search (§ 5.4, § 7.2)
 *
 * Tables (later milestones — declared here as comments, see plan § 5.4):
 *   - (none remaining — M8 is polish only)
 *
 * Virtual tables (managed outside Drizzle in db/client.ts):
 *   - kb_vec_virtual      — sqlite-vec KNN index
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Schema versioning ────────────────────────────────────────────────
export const schemaMeta = sqliteTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

// ─── Settings (key/value) ─────────────────────────────────────────────
/**
 * Generic key/value store. Keys used in M1:
 *   - ollama_base_url
 *   - ollama_model            (chat slot)
 *   - ollama_agent_model      (empty = same as chat)
 *   - ollama_heavy_model      (empty = escalate no-ops)
 *   - ollama_embed_model      (empty = auto)
 *   - identity.user_name
 *   - ui.theme
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

// ─── Episodes ─────────────────────────────────────────────────────────
/**
 * Each chat conversation = one episode. Per § 5.1.
 * Episode isolation: chat history scoped to episode_id; no leaks.
 */
export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(), // cuid generated in app code
    title: text("title"),
    mode: text("mode").notNull().default("chat"), // 'chat' | 'agent' | 'research'
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    summary: text("summary"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
    endedAt: integer("ended_at"),
    lastMessageAt: integer("last_message_at"),
  },
  (t) => ({
    updatedAtIdx: index("episodes_updated_at_idx").on(t.updatedAt),
    isDefaultIdx: index("episodes_is_default_idx").on(t.isDefault),
  }),
);

// ─── Messages ─────────────────────────────────────────────────────────
/**
 * All roles in one table. Per § 5.1.
 * Role: 'user' | 'companion' | 'tool' | 'system'
 * (v2 used 'assistant' — v3 uses 'companion' to match identity model per § 9.3)
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** JSON snapshot: [{ id, name, mimeType, kind, sizeBytes }] for UI reload */
    attachmentsJson: text("attachments_json"),
    /** JSON: EmotionVector snapshot at this message */
    emotionJson: text("emotion_json"),
    /** JSON: [{ name, input, output, success }] — tool calls (M5+) */
    toolCallsJson: text("tool_calls_json"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    episodeIdx: index("messages_episode_id_idx").on(t.episodeId),
    createdIdx: index("messages_created_at_idx").on(t.createdAt),
    episodeCreatedIdx: index("messages_episode_created_idx").on(t.episodeId, t.createdAt),
  }),
);

// ─── Episode facts ────────────────────────────────────────────────────
/**
 * Per-episode context facts. Per § 5.3.
 * Examples: "current project: Lia v2", "user is frustrated about X".
 */
export const episodeFacts = sqliteTable(
  "episode_facts",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    episodeKeyUniq: uniqueIndex("episode_facts_episode_key_uniq").on(t.episodeId, t.key),
    episodeIdx: index("episode_facts_episode_id_idx").on(t.episodeId),
  }),
);

// ─── Global facts ─────────────────────────────────────────────────────
/**
 * Cross-episode user profile. Per § 5.3.
 * Examples: "user.name: redbleach5", "user.profession: developer".
 */
export const globalFacts = sqliteTable("global_facts", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  confidence: real("confidence").notNull().default(0.6),
  hitCount: integer("hit_count").notNull().default(0),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

// ─── Emotional memories ───────────────────────────────────────────────
/**
 * Significant emotional moments. Per § 5.3.
 * Decay: intensity exponential (halfTime ~180d, see v2 emotional-memory.ts).
 */
export const emotionalMemories = sqliteTable(
  "emotional_memories",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    emotion: text("emotion").notNull(), // 'frustration' | 'joy' | 'sadness' | ...
    intensity: real("intensity").notNull().default(0.5),
    trigger: text("trigger").notNull(),
    context: text("context").notNull(),
    emotionVectorJson: text("emotion_vector_json"),
    embedding: blob("embedding", { mode: "buffer" }),
    consolidated: integer("consolidated", { mode: "boolean" }).notNull().default(false),
    sourceIds: text("source_ids"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    episodeIdx: index("emotional_memories_episode_id_idx").on(t.episodeId),
    emotionIdx: index("emotional_memories_emotion_idx").on(t.emotion),
    intensityIdx: index("emotional_memories_intensity_idx").on(t.intensity),
  }),
);

// ─── Vector memory (semantic search per episode) ──────────────────────
/**
 * Embedding index scoped to episode_id + source_type.
 * Per § 10.3. Mirrors v2 VectorMemory table.
 *
 * sourceType: 'dialogue' | 'emotional' | 'fact' | 'summary'
 *
 * Embedding stored as BLOB (Float32Array packed). The kb_vec_virtual
 * vec0 table is the KNN index; this row carries the text + metadata.
 */
export const vectorMemory = sqliteTable(
  "vector_memory",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    text: text("text").notNull(),
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    episodeIdx: index("vector_memory_episode_id_idx").on(t.episodeId),
    sourceIdx: index("vector_memory_source_type_idx").on(t.sourceType),
  }),
);

// ─── Resources — unified abstraction (M2) ─────────────────────────────
/**
 * Unified Resource — replaces v2's ChatAttachment + Source + workspace mount.
 * Per docs/ARCHITECTURE.md § 5.2 + § 6.
 *
 * episodeId null = global (KB source persistent across episodes).
 * episodeId set = scoped to that episode (inline attachment, mounted folder for this chat).
 *
 * kind: 'inline' | 'folder' | 'codebase' | 'symbol' | 'url'
 *   - inline: chat attachment — short-lived, embedded in episode
 *   - folder: mounted filesystem folder — full content indexed (M4)
 *   - codebase: folder with symbol-aware indexing via Tree-sitter (M6)
 *   - symbol: resolved code symbol reference (M6)
 *   - url: web cache, TTL 24h (M5)
 *
 * config (JSON) — kind-specific:
 *   - inline: { storageKey, mimeType, sizeBytes, textPreview }
 *   - folder: { folderPath, watchEnabled, fileHashes, license?, source?, distributionAllowed }
 *   - codebase: { projectPath, languages, excludePatterns, fileHashes, license?, source?, distributionAllowed }
 *   - url: { url, lastFetchedAt }
 *   - symbol: { symbolId, parentResourceId }
 *
 * Addendum A.2 — license/source/distributionAllowed fields in config for KB sources.
 *
 * status: 'idle' | 'indexing' | 'ready' | 'error'
 */
export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    /** null = global (KB source); set = scoped to episode. */
    episodeId: text("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'inline' | 'folder' | 'codebase' | 'symbol' | 'url'
    /** Display name (original filename, folder path basename, KB source name). */
    name: text("name").notNull(),
    /** JSON blob — kind-specific config (see JSDoc above). */
    config: text("config").notNull(),
    status: text("status").notNull().default("idle"), // 'idle' | 'indexing' | 'ready' | 'error'
    chunkCount: integer("chunk_count").notNull().default(0),
    tags: text("tags").notNull().default("[]"), // JSON array
    errorMessage: text("error_message"),
    /** SHA-256 of content (inline: file bytes; folder/codebase: manifest hash). */
    contentHash: text("content_hash"),
    byteSize: integer("byte_size"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
    lastIndexedAt: integer("last_indexed_at"),
  },
  (t) => ({
    episodeIdx: index("resources_episode_id_idx").on(t.episodeId),
    kindIdx: index("resources_kind_idx").on(t.kind),
    statusIdx: index("resources_status_idx").on(t.status),
  }),
);

// ─── Chunks — KB content chunks (M4, per § 7.1) ───────────────────────
/**
 * Content chunks for KB full indexing.
 * Per docs/ARCHITECTURE.md § 7.1 — folder always-full indexing, no manifest mode.
 *
 * Each chunk is a ~2000-char fragment of a document with:
 *   - content: the raw text
 *   - contentHash: SHA-256 for dedup on reindex
 *   - metadata: JSON ({ heading, path, sectionIndex, charStart, charEnd, mimeType, filePath })
 *   - embedding: stored in kb_vec_virtual (vec0) for KNN search
 *
 * parentId + position: for hierarchical documents (heading → sub-heading).
 */
export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    metadata: text("metadata").notNull().default("{}"), // JSON
    parentId: text("parent_id"),
    position: integer("position").notNull().default(0),
    /** Embedding stored as BLOB (Float32Array) for vector search. */
    embedding: blob("embedding", { mode: "buffer" }),
    /** rowid in kb_vec_virtual for KNN lookup (M4.5+ will use this). */
    vecRowid: integer("vec_rowid"),
    indexedAt: integer("indexed_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    resourceIdx: index("chunks_resource_id_idx").on(t.resourceId),
    hashIdx: index("chunks_content_hash_idx").on(t.contentHash),
    parentIdx: index("chunks_parent_id_idx").on(t.parentId),
  }),
);

// ─── Decisions — model reasoning trace (M3, per § 5.3) ────────────────
/**
 * Decision log — Lia's reasoning trace. New layer per docs/ARCHITECTURE.md § 10.4.
 *
 * Does NOT replace episodic memory (that's about the user) — decisions are about
 * Lia herself: what she decided, why, and what the outcome was.
 *
 * When the model makes a decision → write a decision row.
 * When loop or ask_user → Lia reads her decision log for context.
 *
 * modelRole: 'day' | 'heavy' | 'agent'
 *   - day: chat pipeline decision (M3+)
 *   - heavy: escalate decision (M5+)
 *   - agent: agent task decision (M5+)
 *
 * options: JSON array of considered options
 * outcome: filled in later when result is known (nullable)
 */
export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    /** null for chat decisions; set for agent task decisions (M5+). */
    taskId: text("task_id"),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    ts: integer("ts").notNull().default(sql`(unixepoch())`),
    /** What was the context / situation. */
    situation: text("situation").notNull(),
    /** JSON array of considered options. */
    options: text("options").notNull(),
    /** Which option was picked. */
    chosen: text("chosen").notNull(),
    /** Why this option was picked. */
    rationale: text("rationale").notNull(),
    /** Filled in later when result is known. */
    outcome: text("outcome"),
    /** 'day' | 'heavy' | 'agent' */
    modelRole: text("model_role").notNull(),
  },
  (t) => ({
    episodeIdx: index("decisions_episode_id_idx").on(t.episodeId),
    taskIdx: index("decisions_task_id_idx").on(t.taskId),
    tsIdx: index("decisions_ts_idx").on(t.ts),
  }),
);

// ─── Agent tasks — model-driven orchestration (M5, per § 5.5) ──────────
/**
 * Agent task — single streamText with tools, no phase-segregation.
 * Per docs/ARCHITECTURE.md § 5.5 + § 8.1.
 *
 * eventsJson: append-only log of all streaming events (tool_start, tool_end,
 * ask_user, finalize, text_delta). Persisted after each event for resume.
 *
 * status: 'pending' | 'executing' | 'waiting_input' | 'done' | 'failed' | 'cancelled'
 *   Note: NO 'planning' / 'synthesizing' — model-driven, single phase.
 */
export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    /** 'general' | 'researcher' | 'coder' — overlay on system prompt only */
    templateName: text("template_name"),
    status: text("status").notNull().default("pending"),
    /** JSON array of tool names; null = all tools allowed */
    toolsWhitelist: text("tools_whitelist"),
    /** Workspace root for fs operations; null = no fs */
    fsScope: text("fs_scope"),
    maxSteps: integer("max_steps").notNull().default(25),
    maxDurationSec: integer("max_duration_sec").notNull().default(3600),
    currentStep: integer("current_step").notNull().default(0),
    /** JSON array of streaming events (tool_start, tool_end, finalize, etc.) */
    eventsJson: text("events_json").notNull().default("[]"),
    /** JSON array of decision ids for this task */
    decisionIdsJson: text("decision_ids_json").notNull().default("[]"),
    resultSummary: text("result_summary"),
    error: text("error"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (t) => ({
    episodeIdx: index("agent_tasks_episode_id_idx").on(t.episodeId),
    statusIdx: index("agent_tasks_status_idx").on(t.status),
  }),
);

// ─── Code symbols + references — symbol-aware search (M6, per § 5.4) ──
/**
 * Symbol extracted from code via parsing (regex in M6, Tree-sitter in M6.5).
 * Per docs/ARCHITECTURE.md § 5.4 + § 7.2.
 *
 * symbolType: 'function' | 'method' | 'class' | 'interface' | 'type' | 'const'
 * contentHash: SHA-256 of symbol body — for incremental reindex
 */
export const codeSymbols = sqliteTable(
  "code_symbols",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    language: text("language").notNull(), // 'typescript' | 'javascript' | 'python' | ...
    symbolType: text("symbol_type").notNull(), // 'function' | 'method' | 'class' | ...
    name: text("name").notNull(),
    isExported: integer("is_exported", { mode: "boolean" }).notNull().default(false),
    lineStart: integer("line_start").notNull(),
    lineEnd: integer("line_end").notNull(),
    signature: text("signature"),
    contentHash: text("content_hash").notNull(),
  },
  (t) => ({
    resourceIdx: index("code_symbols_resource_id_idx").on(t.resourceId),
    nameIdx: index("code_symbols_name_idx").on(t.name),
    filePathIdx: index("code_symbols_file_path_idx").on(t.filePath),
  }),
);

/**
 * Reference: where a symbol is used.
 * Per docs/ARCHITECTURE.md § 5.4.
 *
 * kind: 'call' | 'import' | 'type_annotation' | 'override'
 */
export const codeReferences = sqliteTable(
  "code_references",
  {
    id: text("id").primaryKey(),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => codeSymbols.id, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    line: integer("line").notNull(),
    column: integer("column").notNull().default(0),
    kind: text("kind").notNull(), // 'call' | 'import' | 'type_annotation' | 'override'
  },
  (t) => ({
    symbolIdx: index("code_references_symbol_id_idx").on(t.symbolId),
    resourceIdx: index("code_references_resource_id_idx").on(t.resourceId),
    filePathIdx: index("code_references_file_path_idx").on(t.filePath),
  }),
);

// ─── Type exports ─────────────────────────────────────────────────────
export type SchemaMeta = typeof schemaMeta.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Episode = typeof episodes.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type EpisodeFact = typeof episodeFacts.$inferSelect;
export type GlobalFact = typeof globalFacts.$inferSelect;
export type EmotionalMemory = typeof emotionalMemories.$inferSelect;
export type VectorMemory = typeof vectorMemory.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type CodeSymbolRow = typeof codeSymbols.$inferSelect;
export type CodeReferenceRow = typeof codeReferences.$inferSelect;
