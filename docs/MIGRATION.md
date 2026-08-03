# Migration Guide: Lia v2 → v3

This guide covers migrating your data from Lia v2 (Next.js + Prisma) to Lia v3 (Hono + Drizzle).

## Overview

Lia v3 is a greenfield rewrite with a different schema, but the core data (episodes, messages, facts, memories, settings) is preserved. The migration script reads your v2 SQLite database and writes to a fresh v3 database.

### What migrates

| v2 Table | v3 Table | Notes |
|----------|----------|-------|
| Episode | episodes | Identical shape |
| Message | messages | role `assistant` → `companion` |
| GlobalFact | global_facts | Identical |
| EpisodeFact | episode_facts | ID prefix added (`ef_`) |
| EmotionalMemory | emotional_memories | Identical |
| Setting | settings | Key remapping (see below) |
| Source | resources | Type → kind mapping (see below) |

### What doesn't migrate

| v2 Entity | Reason |
|-----------|--------|
| ChatAttachment | Replaced by Resource(kind=inline) in v3 — requires file re-upload |
| VectorMemory | Embeddings are model-specific; v3 re-embeds on next chat turn |
| AgentTask | v3 has different schema (eventsJson, no phase-segregation) |
| Person / PersonFact | v3 uses GlobalFact with `user.*` keys instead |

## Prerequisites

1. **Backup your v2 database** before starting:
   ```bash
   cp path/to/v2/db/lia.db lia-v2-backup.db
   ```

2. Install v3 dependencies:
   ```bash
   cd LIA-v3
   npm install
   ```

3. Ensure Ollama is running with the same models as v2 (for re-embedding).

## Running the migration

### Step 1: Dry run (recommended)

Test the migration without writing to the v3 database:

```bash
cd apps/backend
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db --dry-run
```

This shows what would be migrated and reports any errors. No data is written.

### Step 2: Live migration

```bash
cd apps/backend
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db
```

By default, this writes to `./data/lia.db`. To specify a different path:

```bash
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db --v3-db-path=/custom/path/lia.db
```

### Step 3: Apply v3 schema

If you didn't use the migration script (which creates tables automatically), apply the v3 schema:

```bash
npm run db:push
```

### Step 4: Verify

Start the v3 backend and check that your data appears:

```bash
npm run dev
# Visit http://127.0.0.1:5173
# Check episodes, messages, and settings
```

## Key mapping: v2 Setting → v3 settings

| v2 Key | v3 Key | Notes |
|--------|--------|-------|
| ollama_base_url | ollama_base_url | Same |
| ollama_model | ollama_model | Same |
| ollama_agent_model | ollama_agent_model | Same |
| ollama_heavy_model | ollama_heavy_model | Same |
| ollama_embed_model | ollama_embed_model | Same |
| ollama_secondary_model | — | Removed in v3 (consolidated to 4 slots) |
| Other keys | — | Skipped (see migration output) |

## Type mapping: v2 Source → v3 resources

| v2 Source Type | v3 Resource Kind | Notes |
|----------------|------------------|-------|
| document | folder | Treated as folder in v3 |
| folder | folder | Full content indexing (no manifest mode) |
| codebase | codebase | Symbol indexing via parser (M6) |
| url | url | Web cache (M5.5) |

All migrated resources get `license: "Unknown"` and `distributionAllowed: true` by default. Update these in the v3 UI (Workspace panel → click resource → edit).

## Post-migration

### Re-index KB sources

v3 uses a different indexing pipeline. After migration, re-index your folder/codebase resources:

1. Open the v3 UI
2. Go to Workspace panel
3. For each folder/codebase resource, click "Reindex"

Or via API:
```bash
curl -X POST http://127.0.0.1:8787/api/resources/<resource-id>/reindex
```

### Re-embed vector memory

v3's vector memory is per-episode (like v2) but uses the v3 embedding pipeline. New chat turns will automatically create vector memories. Old v2 VectorMemory rows are NOT migrated (embeddings are model-specific).

### Upload VRM avatar (if you had one in v2)

v2 VRM files are stored in `public/models/`. In v3, upload via Settings → Avatar:

1. Open Settings → Avatar tab
2. Upload your `.vrm` file

## Troubleshooting

### "v2 database not found"

Ensure the path is correct. The v2 database is typically at `prisma/dev.db` or a custom path in your `.env`.

### "table not found in v2, skipping"

The migration script skips tables that don't exist in your v2 database. This is normal if you didn't use all v2 features.

### Errors during migration

The script reports errors per-row and continues. Review the warnings, fix the v2 data if needed, and re-run. The `--dry-run` flag is useful for debugging.

### Data verification

After migration, verify counts:
```bash
# v2
sqlite3 /path/to/v2/lia.db "SELECT COUNT(*) FROM Episode; SELECT COUNT(*) FROM Message;"

# v3
sqlite3 ./data/lia.db "SELECT COUNT(*) FROM episodes; SELECT COUNT(*) FROM messages;"
```

Counts should match (messages may differ slightly if v2 had `assistant` role messages — these become `companion` in v3).
