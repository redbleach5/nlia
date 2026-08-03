/**
 * Loop detector — detect repetitive tool patterns and inject hints.
 *
 * Per docs/ARCHITECTURE.md § 8.5.
 *
 * Pattern loop: same tool + same input N times → inject hint
 * Empty results: tool returns empty N times → inject strategy hint
 *
 * Hints are soft nudges via context augmentation (not separate phases).
 * The model sees the hint and decides what to do with it.
 */

import type { AgentEvent } from "@lia/shared";

const PATTERN_LOOP_THRESHOLD = 3;
const EMPTY_RESULTS_THRESHOLD = 3;

export interface LoopHint {
  type: "pattern_loop" | "empty_results" | "semantic_loop";
  message: string;
}

/**
 * Analyze recent events for loop patterns.
 * Returns a hint to inject if a loop is detected, null otherwise.
 */
export function detectLoop(events: AgentEvent[]): LoopHint | null {
  const toolEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end",
  );

  if (toolEvents.length < PATTERN_LOOP_THRESHOLD) return null;

  // Check for pattern loop: same tool name repeated N times with similar inputs
  const recent = toolEvents.slice(-PATTERN_LOOP_THRESHOLD);
  const toolNames = recent.map((e) => e.tool);
  const allSameTool = toolNames.every((t) => t === toolNames[0]);

  if (allSameTool && toolNames[0] !== "finalize" && toolNames[0] !== "ask_user") {
    // Check if inputs were similar (we don't have tool_start inputs in tool_end,
    // so we check if summaries are similar)
    const summaries = recent.map((e) => e.summary);
    const allSimilar = summaries.every((s) => s === summaries[0]);
    if (allSimilar) {
      return {
        type: "pattern_loop",
        message: `You've called ${toolNames[0]} ${PATTERN_LOOP_THRESHOLD} times with similar results. Consider trying a different approach or asking the user for clarification.`,
      };
    }
  }

  // Check for empty results N times
  const emptyResults = toolEvents.filter(
    (e) => e.success && (e.summary.includes("0 items") || e.summary.includes("no output") || e.summary.includes("empty")),
  );
  if (emptyResults.length >= EMPTY_RESULTS_THRESHOLD) {
    return {
      type: "empty_results",
      message: `Your last ${EMPTY_RESULTS_THRESHOLD} tool calls returned empty results. Try broadening your search, checking different paths, or reconsidering your approach.`,
    };
  }

  return null;
}
