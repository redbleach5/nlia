#!/usr/bin/env node
/**
 * One-shot / CLI: apply chat-attachment columns to an existing SQLite DB.
 * Idempotent — safe to re-run. Prefer `bun run db:push` (now patches too)
 * or just restart `bun run dev` (startup applies the same patches).
 */
import { applySchemaPatches } from './lib/apply-schema-patches.mjs';

const result = applySchemaPatches();
if (result.skipped.includes('db-missing')) {
  console.error('DB not found:', result.dbPath);
  process.exit(1);
}
if (result.applied.length > 0) {
  console.log('✓ Applied:', result.applied.join(', '));
} else {
  console.log('✓ Already up to date');
}
console.log('Done:', result.dbPath);
