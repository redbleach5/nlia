/**
 * Context budget — compute how much dialogue history fits in context window.
 *
 * Per docs/ARCHITECTURE.md § 2.6 (long context as first-class).
 * Refactored from v2: NO TIER_INFERENCE_CTX_CAP.
 *
 * Uses the real modelContextWindow from CapabilityProfile (Ollama /api/show),
 * NOT a hardcoded cap. Qwen3 32B with 128k context → uses 128k.
 *
 * Budget = effectiveContextWindow - systemPromptTokens - reservedForResponse
 */

import type { CapabilityProfile } from "./capability-profile.js";
import type { Message } from "@lia/shared";

const CHARS_PER_TOKEN = 3.0;
const SAFETY_MARGIN_TOKENS = 512;
const MAX_MESSAGES_TO_CONSIDER = 50;

export interface ContextBudget {
  /** Total context window (tokens) */
  contextWindow: number;
  /** Tokens reserved for system prompt */
  systemPromptTokens: number;
  /** Tokens reserved for model response */
  responseReserveTokens: number;
  /** Available tokens for dialogue history */
  availableForDialogue: number;
  /** Messages that fit within budget (most recent N) */
  selectedMessages: Message[];
  /** Whether the oldest messages were truncated */
  truncated: boolean;
}

/**
 * Compute the context budget for a chat turn.
 *
 * @param profile     capability profile (from Ollama /api/show)
 * @param systemPrompt the system prompt text
 * @param history     all messages in the episode (oldest first)
 * @returns budget with selected messages that fit
 */
export function computeDialogueBudget(
  profile: CapabilityProfile,
  systemPrompt: string,
  history: Message[],
): ContextBudget {
  const contextWindow = profile.effectiveContextWindow;
  const systemPromptTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const responseReserveTokens = Math.min(profile.maxOutputTokens + SAFETY_MARGIN_TOKENS, contextWindow * 0.25);
  const availableForDialogue = contextWindow - systemPromptTokens - responseReserveTokens;

  // Take most recent N messages (soft cap)
  const candidates = history.slice(-MAX_MESSAGES_TO_CONSIDER);

  // Fit messages from most recent backwards
  const selected: Message[] = [];
  let usedTokens = 0;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i]!;
    const msgTokens = Math.ceil((msg.content.length + 10) / CHARS_PER_TOKEN); // +10 for role overhead
    if (usedTokens + msgTokens > availableForDialogue) break;
    selected.unshift(msg);
    usedTokens += msgTokens;
  }

  return {
    contextWindow,
    systemPromptTokens,
    responseReserveTokens,
    availableForDialogue,
    selectedMessages: selected,
    truncated: selected.length < history.length,
  };
}
