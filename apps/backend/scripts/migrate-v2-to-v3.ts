/**
 * Migration script: v2 SQLite (Prisma) → v3 SQLite (Drizzle).
 *
 * Per docs/ARCHITECTURE.md § 12 + § 13.10.
 *
 * Reads a v2 SQLite database and converts its data to the v3 schema:
 *   - Episode → episodes (identical shape)
 *   - Message → messages (role 'assistant' → 'companion')
 *   - GlobalFact → global_facts
 *   - EpisodeFact → episode_facts
 *   - EmotionalMemory → emotional_memories
 *   - Setting → settings (key remapping)
 *   - Source (folder/codebase) → resources (kind mapping)
 *
 * Usage:
 *   npx tsx scripts/migrate-v2-to-v3.ts <v2-db-path> [--dry-run] [--v3-db-path=<path>]
 *
 * Default v3 DB path: ./data/lia.db (overridden by LIA_DB_PATH env)
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ─── CLI parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const v2DbPath = args[0];
const dryRun = args.includes("--dry-run");
const v3DbPathArg = args.find((a) => a.startsWith("--v3-db-path="));
const v3DbPath = v3DbPathArg
  ? v3DbPathArg.split("=")[1]!
  : process.env.LIA_DB_PATH ?? resolve(process.cwd(), "data/lia.db");

if (!v2DbPath) {
  console.error("Usage: npx tsx scripts/migrate-v2-to-v3.ts <v2-db-path> [--dry-run] [--v3-db-path=<path>]");
  process.exit(1);
}

if (!existsSync(v2DbPath)) {
  console.error(`v2 database not found: ${v2DbPath}`);
  process.exit(1);
}

console.log(`┌─ Migration v2 → v3`);
console.log(`│  v2 source: ${v2DbPath}`);
console.log(`│  v3 target: ${v3DbPath}`);
console.log(`│  mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE (will write to v3 DB)"}`);
console.log(`└─`);

// ─── Open databases ───────────────────────────────────────────────────
const v2 = new Database(v2DbPath, { readonly: true });

if (!dryRun) {
  const v3Dir = dirname(v3DbPath);
  if (!existsSync(v3Dir)) {
    mkdirSync(v3Dir, { recursive: true });
  }
}

const v3 = dryRun ? new Database(":memory:") : new Database(v3DbPath);

// ─── Migration stats ──────────────────────────────────────────────────
const stats = {
  episodes: 0,
  messages: 0,
  globalFacts: 0,
  episodeFacts: 0,
  emotionalMemories: 0,
  settings: 0,
  resources: 0,
  skipped: 0,
  errors: 0,
};

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function getRow(row: unknown, col: string): unknown {
  if (row && typeof row === "object" && col in row) {
    return (row as Record<string, unknown>)[col];
  }
  return undefined;
}

function toUnixTs(val: unknown): number {
  if (val instanceof Date) return Math.floor(val.getTime() / 1000);
  if (typeof val === "string") {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }
  if (typeof val === "number") return val;
  return Math.floor(Date.now() / 1000);
}

// ─── Ensure v3 schema exists ──────────────────────────────────────────
function ensureV3Schema(): void {
  v3.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY, title TEXT, mode TEXT NOT NULL DEFAULT 'chat',
      is_default INTEGER NOT NULL DEFAULT 0, summary TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at INTEGER, last_message_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, attachments_json TEXT,
      emotion_json TEXT, tool_calls_json TEXT,
      tokens_in INTEGER, tokens_out INTEGER, duration_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS global_facts (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.6, hit_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS episode_facts (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      key TEXT NOT NULL, value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS emotional_memories (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      emotion TEXT NOT NULL, intensity REAL NOT NULL DEFAULT 0.5,
      trigger TEXT NOT NULL, context TEXT NOT NULL,
      emotion_vector_json TEXT, embedding BLOB,
      consolidated INTEGER NOT NULL DEFAULT 0, source_ids TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', chunk_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]', error_message TEXT,
      content_hash TEXT, byte_size INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_indexed_at INTEGER
    );
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', 'm8-migrated');
  `);
}

// ─── Migrate functions ────────────────────────────────────────────────

function migrateEpisodes(): void {
  if (!tableExists(v2, "Episode")) {
    console.log("  ⏭ Episode table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM Episode").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO episodes (id, title, mode, is_default, summary, created_at, updated_at, ended_at, last_message_at)
     VALUES (?, ?, 'chat', 0, ?, ?, ?, ?, NULL)`,
  );
  for (const row of rows) {
    try {
      insert.run(
        getRow(row, "id"),
        getRow(row, "title"),
        getRow(row, "summary"),
        toUnixTs(getRow(row, "createdAt")),
        toUnixTs(getRow(row, "updatedAt")),
        getRow(row, "endedAt") ? toUnixTs(getRow(row, "endedAt")) : null,
      );
      stats.episodes++;
    } catch (e) {
      console.warn(`  ⚠ episode ${getRow(row, "id")} failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ episodes: ${stats.episodes}`);
}

function migrateMessages(): void {
  if (!tableExists(v2, "Message")) {
    console.log("  ⏭ Message table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM Message").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO messages (id, episode_id, role, content, attachments_json, emotion_json, tool_calls_json, tokens_in, tokens_out, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    try {
      const role = getRow(row, "role") as string;
      const v3Role = role === "assistant" ? "companion" : role;
      insert.run(
        getRow(row, "id"),
        getRow(row, "episodeId"),
        v3Role,
        getRow(row, "content"),
        getRow(row, "attachmentsJson"),
        getRow(row, "emotionJson"),
        getRow(row, "toolCallsJson"),
        getRow(row, "tokensIn"),
        getRow(row, "tokensOut"),
        getRow(row, "durationMs"),
        toUnixTs(getRow(row, "createdAt")),
      );
      stats.messages++;
    } catch (e) {
      console.warn(`  ⚠ message ${getRow(row, "id")} failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ messages: ${stats.messages}`);
}

function migrateGlobalFacts(): void {
  if (!tableExists(v2, "GlobalFact")) {
    console.log("  ⏭ GlobalFact table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM GlobalFact").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO global_facts (key, value, confidence, hit_count, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    try {
      insert.run(
        getRow(row, "key"),
        getRow(row, "value"),
        (getRow(row, "confidence") as number) ?? 0.6,
        (getRow(row, "hitCount") as number) ?? 0,
        toUnixTs(getRow(row, "updatedAt")),
      );
      stats.globalFacts++;
    } catch (e) {
      console.warn(`  ⚠ global fact ${getRow(row, "key")} failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ global_facts: ${stats.globalFacts}`);
}

function migrateEpisodeFacts(): void {
  if (!tableExists(v2, "EpisodeFact")) {
    console.log("  ⏭ EpisodeFact table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM EpisodeFact").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO episode_facts (id, episode_id, key, value, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    try {
      const id = `ef_${getRow(row, "id")}`;
      insert.run(
        id,
        getRow(row, "episodeId"),
        getRow(row, "key"),
        getRow(row, "value"),
        toUnixTs(getRow(row, "ts")),
      );
      stats.episodeFacts++;
    } catch (e) {
      console.warn(`  ⚠ episode fact failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ episode_facts: ${stats.episodeFacts}`);
}

function migrateEmotionalMemories(): void {
  if (!tableExists(v2, "EmotionalMemory")) {
    console.log("  ⏭ EmotionalMemory table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM EmotionalMemory").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO emotional_memories (id, episode_id, emotion, intensity, trigger, context, emotion_vector_json, embedding, consolidated, source_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    try {
      insert.run(
        getRow(row, "id"),
        getRow(row, "episodeId"),
        getRow(row, "emotion"),
        (getRow(row, "intensity") as number) ?? 0.5,
        getRow(row, "trigger"),
        getRow(row, "context"),
        getRow(row, "emotionVectorJson"),
        getRow(row, "embedding"),
        getRow(row, "consolidated") ? 1 : 0,
        getRow(row, "sourceIds"),
        toUnixTs(getRow(row, "ts")),
      );
      stats.emotionalMemories++;
    } catch (e) {
      console.warn(`  ⚠ emotional memory ${getRow(row, "id")} failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ emotional_memories: ${stats.emotionalMemories}`);
}

function migrateSettings(): void {
  if (!tableExists(v2, "Setting")) {
    console.log("  ⏭ Setting table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM Setting").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
  );

  const keyMap: Record<string, string> = {
    ollama_base_url: "ollama_base_url",
    ollama_model: "ollama_model",
    ollama_agent_model: "ollama_agent_model",
    ollama_heavy_model: "ollama_heavy_model",
    ollama_embed_model: "ollama_embed_model",
  };

  for (const row of rows) {
    try {
      const v2Key = getRow(row, "key") as string;
      const v3Key = keyMap[v2Key];
      if (!v3Key) {
        stats.skipped++;
        continue;
      }
      insert.run(v3Key, getRow(row, "value"), toUnixTs(getRow(row, "updatedAt")));
      stats.settings++;
    } catch (e) {
      console.warn(`  ⚠ setting failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ settings: ${stats.settings} (skipped ${stats.skipped} unknown keys)`);
}

function migrateSourcesToResources(): void {
  if (!tableExists(v2, "Source")) {
    console.log("  ⏭ Source table not found in v2, skipping");
    return;
  }
  const rows = v2.prepare("SELECT * FROM Source").all() as Record<string, unknown>[];
  const insert = v3.prepare(
    `INSERT OR IGNORE INTO resources (id, episode_id, kind, name, config, status, chunk_count, tags, error_message, created_at, updated_at, last_indexed_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  );

  const typeToKind: Record<string, string> = {
    document: "folder",
    folder: "folder",
    codebase: "codebase",
    url: "url",
  };

  for (const row of rows) {
    try {
      const v2Type = getRow(row, "type") as string;
      const v3Kind = typeToKind[v2Type] ?? "folder";
      const v2Config = JSON.parse(getRow(row, "config") as string) as Record<string, unknown>;

      const v3Config: Record<string, unknown> = {
        license: "Unknown",
        source: v2Config.folderPath ?? v2Config.url ?? "migrated from v2",
        distributionAllowed: true,
        ...v2Config,
      };

      insert.run(
        getRow(row, "id"),
        v3Kind,
        getRow(row, "name"),
        JSON.stringify(v3Config),
        getRow(row, "status") ?? "idle",
        (getRow(row, "chunkCount") as number) ?? 0,
        getRow(row, "errorMessage"),
        toUnixTs(getRow(row, "createdAt")),
        toUnixTs(getRow(row, "updatedAt")),
        getRow(row, "lastIndexedAt") ? toUnixTs(getRow(row, "lastIndexedAt")) : null,
      );
      stats.resources++;
    } catch (e) {
      console.warn(`  ⚠ source ${getRow(row, "id")} failed:`, e);
      stats.errors++;
    }
  }
  console.log(`  ✓ resources (from sources): ${stats.resources}`);
}

// ─── Run migration ────────────────────────────────────────────────────
console.log("\nMigrating...");

if (!dryRun) {
  ensureV3Schema();
}

const migrate = v3.transaction(() => {
  migrateEpisodes();
  migrateMessages();
  migrateGlobalFacts();
  migrateEpisodeFacts();
  migrateEmotionalMemories();
  migrateSettings();
  migrateSourcesToResources();
});

migrate();

// ─── Summary ──────────────────────────────────────────────────────────
console.log("\n┌─ Migration complete");
console.log(`│  episodes:           ${stats.episodes}`);
console.log(`│  messages:           ${stats.messages}`);
console.log(`│  global_facts:       ${stats.globalFacts}`);
console.log(`│  episode_facts:      ${stats.episodeFacts}`);
console.log(`│  emotional_memories: ${stats.emotionalMemories}`);
console.log(`│  settings:           ${stats.settings}`);
console.log(`│  resources:          ${stats.resources}`);
console.log(`│  skipped:            ${stats.skipped}`);
console.log(`│  errors:             ${stats.errors}`);
console.log(`└─ ${dryRun ? "(dry run — no data written)" : `Written to ${v3DbPath}`}`);

if (stats.errors > 0) {
  console.warn(`\n⚠ ${stats.errors} errors occurred during migration. Review the warnings above.`);
  process.exitCode = 1;
}

v2.close();
v3.close();
