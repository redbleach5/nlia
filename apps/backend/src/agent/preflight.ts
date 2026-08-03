/**
 * PreFlightAskUser gate — try other paths before asking the user.
 *
 * Per docs/ARCHITECTURE.md § 8.4.
 *
 * Before ask_user, try:
 *   1. Heavy model escalate (if not yet used in this task)
 *   2. Web search (if not yet tried and goal is not coding)
 *   3. KB search (if not yet tried)
 *   4. Decision log reflection (if recent decisions had failures)
 *
 * Budget: max 2 auto-retries before ask_user.
 */

import type { AgentEvent } from "@lia/shared";
import { listDecisions } from "../memory/decisions.js";
import { getHeavyModelName } from "../llm/ollama.js";
import { logger } from "../util/logger.js";

export type PreFlightResult = "ask" | "continue";

/**
 * Check whether to ask the user or try another path first.
 *
 * @param episodeId  episode id
 * @param taskId     task id
 * @param events     events so far in this task
 * @param retries    number of auto-retries already used
 * @returns 'ask' to proceed with ask_user, 'continue' to try another path
 */
export async function preFlightAskUser(
  episodeId: string,
  _taskId: string,
  events: AgentEvent[],
  retries: number,
): Promise<PreFlightResult> {
  // Budget exhausted → ask
  if (retries >= 2) {
    logger.info({ episodeId, retries }, "preflight: budget exhausted, asking user");
    return "ask";
  }

  // 1. Heavy model escalate
  const heavy = await getHeavyModelName();
  if (heavy) {
    // Check if heavy was already used (look for a "heavy_escalate" event)
    const usedHeavy = events.some(
      (e) => e.type === "status" && e.label.includes("heavy"),
    );
    if (!usedHeavy) {
      logger.info({ episodeId }, "preflight: suggest heavy escalate");
      return "continue";
    }
  }

  // 2. Web search if not yet tried
  const hasWebSearch = events.some(
    (e) => e.type === "tool_end" && e.tool === "web_search",
  );
  if (!hasWebSearch) {
    logger.info({ episodeId }, "preflight: suggest web search");
    return "continue";
  }

  // 3. KB search if not yet tried
  const hasKbSearch = events.some(
    (e) => e.type === "tool_end" && (e.tool === "search_sources" || e.tool === "search_codebase"),
  );
  if (!hasKbSearch) {
    logger.info({ episodeId }, "preflight: suggest KB search");
    return "continue";
  }

  // 4. Decision log reflection
  const recentDecisions = listDecisions(episodeId, { limit: 5 });
  if (recentDecisions.some((d) => d.outcome === "failure")) {
    logger.info({ episodeId }, "preflight: suggest different approach (recent failures)");
    return "continue";
  }

  // All paths exhausted → ask
  logger.info({ episodeId }, "preflight: all paths exhausted, asking user");
  return "ask";
}
