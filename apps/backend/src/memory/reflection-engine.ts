/**
 * Reflection engine — periodic consolidation of memories.
 *
 * Per docs/ARCHITECTURE.md § 10.4.
 *
 * Patch (reroute): `runReflection` is a safe entry point. It runs the FULL
 * LLM-based consolidation (reflection-full.ts) only when explicitly enabled
 * via `LIA_REFLECTION_LLM=1` (or `opts.full: true`). Default path returns a
 * stub-like summary synchronously (no LLM call) — same shape as M3, so
 * existing tests and low-latency callers are unaffected.
 *
 * The full consolidation itself is exported as `runFullReflection` for
 * direct/opt-in use (routes, cron).
 */

import { getRecentEmotionalMemories, type EmotionalMemoryDTO } from "./emotional-memory.js";
import { getAllGlobalFacts, upsertGlobalFact, type GlobalFactDTO } from "./facts.js";
import { listDecisions } from "./decisions.js";
import { logger } from "../util/logger.js";
import { runFullReflection } from "./reflection-full.js";

export interface ReflectionInput {
  episodeId: string;
  emotionalMemories: EmotionalMemoryDTO[];
  existingGlobalFacts: GlobalFactDTO[];
}

export interface ReflectionResult {
  /** New global facts derived from reflection. */
  newFacts: Array<{ key: string; value: string }>;
  /** Summary of what was considered. */
  summary: string;
  /** Whether reflection actually ran. */
  ran: boolean;
}

/**
 * Run reflection on an episode's memories + decisions.
 *
 * - Default: synchronous stub (no LLM call) — fast and safe.
 * - Full mode: set `LIA_REFLECTION_LLM=1` env or pass `{ full: true }`.
 */
export async function runReflection(
  episodeId: string,
  opts?: { full?: boolean },
): Promise<ReflectionResult> {
  const enabled =
    opts?.full === true ||
    process.env.LIA_REFLECTION_LLM === "1" ||
    process.env.LIA_REFLECTION_LLM === "true";

  if (enabled) {
    return runFullReflection(episodeId);
  }

  const emotionalMemories = getRecentEmotionalMemories(10);
  const existingFacts = getAllGlobalFacts();
  const recentDecisions = listDecisions(episodeId, { limit: 5 });

  logger.info(
    {
      episodeId,
      emotionalMemoryCount: emotionalMemories.length,
      decisionCount: recentDecisions.length,
      existingFactCount: existingFacts.length,
    },
    "reflection engine stub invoked (default, no LLM call)",
  );

  return {
    newFacts: [],
    summary: [
      `Reflection stub: considered ${emotionalMemories.length} emotional memories,`,
      `${recentDecisions.length} recent decisions,`,
      `${existingFacts.length} existing global facts.`,
      "Full reflection (LLM-based insight extraction) available when LIA_REFLECTION_LLM=1.",
    ].join(" "),
    ran: false,
  };
}

// Full LLM-based consolidation — exported for explicit callers (routes, cron).
export { runFullReflection };

// Called by reflection-full.ts after the LLM call.
export function persistReflectionFacts(facts: Array<{ key: string; value: string }>): void {
  for (const f of facts) {
    upsertGlobalFact(f.key, f.value, 0.6);
  }
  if (facts.length > 0) {
    logger.info({ count: facts.length }, "reflection facts persisted");
  }
}
