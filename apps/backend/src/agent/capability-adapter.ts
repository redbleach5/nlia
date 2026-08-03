/**
 * CapabilityAdapter — adaptive intelligence knobs for the orchestrator.
 *
 * Adapts orchestration parameters based on the currently configured model's
 * tier (micro → max). Small models (≤14B) get more guidance: capped turns,
 * explicit CoT planning, stricter tool-calling scaffolding. Large models get
 * freedom and higher constraints.
 *
 * Design goal: boost capability on low-end (7B–14B) without throttling premium
 * models (70B+). The knobs are not hardcoded per model name, but derived from
 * the model's measured tier — so upgrading the model automatically unlocks
 * higher limits.
 */

export type AgentTier = "micro" | "standard" | "plus" | "max";

/** Detect agent tier from a model name (robust to suffixes like :latest). */
export function detectAgentTier(modelName: string): AgentTier {
  const lower = modelName.toLowerCase();

  // Extra-large / frontier models
  if (/(gpt-4|gpt-5|claude|o1|llama-4|405|70b|72b|104b|120b|235b|deepseek-r1|qwen2\.5-72|qwen3-32|qwen3-235|command-r-plus)/.test(lower)) {
    return "max";
  }
  // Strong mid-range models
  if (/(gpt-3\.5|claude|gemma|llama-3\.1|13b|14b|16b|24b|32b|34b|mixtral|qwen2\.5-32|command-r|yi-34|phi-4|mistral)/.test(lower)) {
    return "plus";
  }
  // Standard consumer models
  if (/(7b|8b|9b|11b|llama|qwen|qwen2|qwen2\.5|gemma|mistral|phi|olmo|dolphin|openchat|codellama|deepseek)/.test(lower)) {
    return "standard";
  }
  // Tiny / utility models
  return "micro";
}

/** Per-tier orchestration parameters. */
export interface AgentProfile {
  /** Max turns before finalize. Prevents rambling on small models. */
  maxSteps: number;
  /** Use explicit plan-first reasoning (CoT)? Small models benefit more. */
  useExplicitPlanning: boolean;
  /** Temperature hint (lower = deterministic, higher = creative). */
  temperature: number;
  /** Should self-critique be enabled after each step? */
  selfCritique: boolean;
  /** Max tool output shown verbatim in prompt context. */
  maxContextChars: number;
}

export function getAgentProfile(tier: AgentTier): AgentProfile {
  switch (tier) {
    case "micro":
      return { maxSteps: 4, useExplicitPlanning: true, temperature: 0.1, selfCritique: false, maxContextChars: 4000 };
    case "standard":
      return { maxSteps: 8, useExplicitPlanning: true, temperature: 0.2, selfCritique: false, maxContextChars: 12000 };
    case "plus":
      return { maxSteps: 12, useExplicitPlanning: true, temperature: 0.3, selfCritique: true, maxContextChars: 24000 };
    case "max":
      return { maxSteps: 24, useExplicitPlanning: false, temperature: 0.4, selfCritique: true, maxContextChars: 64000 };
  }
}

/**
 * Coding / volume work needs more steps than chatty micro-caps allow.
 * Merges tier profile with a coder floor so feature work isn't cut at step 4–8.
 */
export function getCoderProfile(tier: AgentTier): AgentProfile {
  const base = getAgentProfile(tier);
  const coderFloor =
    tier === "micro" ? 16 : tier === "standard" ? 24 : tier === "plus" ? 36 : 48;
  return {
    ...base,
    maxSteps: Math.max(base.maxSteps, coderFloor),
    useExplicitPlanning: true,
    // Slightly more deterministic for large multi-file dumps
    temperature: Math.min(base.temperature, 0.25),
  };
}
