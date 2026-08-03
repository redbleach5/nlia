/**
 * Prompt safety — escape user/LLM-derived content before system-prompt injection.
 *
 * Per docs/ARCHITECTURE.md § Appendix A: "port".
 * Prevents prompt injection from KB content, fact values, attachment text.
 */

/**
 * Escape a string for safe injection into a system prompt.
 * Strips control characters, normalizes whitespace, adds label for debug.
 */
export function escapeForPrompt(text: string, opts?: { label?: string }): string {
  const label = opts?.label ? `[${opts.label}] ` : "";
  // Strip null bytes + control chars (except newline/tab)
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Limit length
  const trimmed = cleaned.length > 5000 ? cleaned.slice(0, 5000) + "…[truncated]" : cleaned;
  return `${label}${trimmed}`;
}

/**
 * Extract a JSON object from LLM output.
 * Handles markdown code fences + leading/trailing prose.
 */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Check if text contains potential prompt injection patterns.
 * Returns true if suspicious content detected.
 */
export function detectPromptInjection(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    "ignore previous instructions",
    "ignore the above",
    "system prompt:",
    "you are now",
    "forget everything",
    "new instructions:",
    "игнорируй предыдущие",
    "забудь всё",
    "ты теперь",
  ];
  return patterns.some((p) => lower.includes(p));
}
