/**
 * Agent goal display + template overlay helpers (Cursor-like separation).
 *
 * - `goal` / UI: user text only
 * - `systemOverlay`: template instructions for the LLM system channel only
 *
 * Also repairs legacy tasks where template text was concatenated as:
 *   `${template}\n\n## ЗАДАЧА\n${userGoal}`
 */

const TASK_MARKER_RE = /##\s*ЗАДАЧА\s*\n?/i;

/** User-facing goal — strips legacy template prefix if present. */
export function displayAgentGoal(goal: string): string {
  const text = goal.trim();
  if (!text) return '';
  const match = TASK_MARKER_RE.exec(text);
  if (match && match.index != null) {
    return text.slice(match.index + match[0].length).trim();
  }
  return text;
}

/** Template block stored before ## ЗАДАЧА on legacy contaminated goals. */
export function extractLegacyTemplateOverlay(rawGoal: string): string {
  const text = rawGoal.trim();
  if (!text) return '';
  const match = TASK_MARKER_RE.exec(text);
  if (!match || match.index == null || match.index === 0) return '';
  return text.slice(0, match.index).trim();
}

/** Prepend template instructions to an LLM system prompt (never into goal). */
export function withTemplateOverlay(systemPrompt: string, overlay: string | null | undefined): string {
  const o = (overlay ?? '').trim();
  if (!o) return systemPrompt;
  return `${o}\n\n---\n\n${systemPrompt}`;
}
