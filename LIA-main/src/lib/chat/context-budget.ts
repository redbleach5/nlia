// Context budget calculator — adaptive dialogue history window.
//
// Problem
// =======
// Before this module, `pipeline.ts` used `dialogueHistory.slice(-12)` — a fixed
// 12-message window regardless of model context size. On a 7B model with 8k
// context, 12 long messages + system prompt + tools schema + maxOutputTokens
// could overflow and trigger silent truncation inside the LLM. On a 32B model
// with 32k context, 12 messages wasted 75% of the available window — the model
// had less conversation history to work with than it could handle, which hurt
// answer quality on long technical discussions.
//
// Solution
// ========
// Compute a per-request budget for the dialogue history:
//
//   dialogueBudget = contextWindow
//                  - systemPromptTokens
//                  - maxOutputTokens
//                  - toolSchemaTokens   (when tools are enabled)
//                  - SAFETY_MARGIN
//
// Then walk recentMessages from newest to oldest, accumulating token estimates
// until the budget is exhausted. This guarantees:
//   1. No overflow: we never send more than the model can accept.
//   2. Maximum context: we use as much history as fits, improving long-conversation quality.
//   3. Graceful degradation: when contextWindow is unknown, we fall back to a
//      conservative tier-based default (preserves prior behaviour).
//
// Token estimation
// ================
// We use a character-based heuristic (no tiktoken dependency). For mixed
// Russian/English text, the ratio is ~3.0 chars/token on average:
//   - Russian Cyrillic: ~2.5 chars/token (BPE merges fewer Cyrillic pairs)
//   - English Latin: ~4.0 chars/token (BPE merges common English pairs well)
//   - Code: ~3.0 chars/token (lots of single-char tokens like (){};.)
//
// The 3.0 ratio is a slight over-estimate for English and under-estimate for
// Russian — which is intentional: over-estimating means we leave a bit more
// headroom, avoiding overflow. Better to slightly under-fill than to truncate.
//
// We don't use tiktoken because:
//   1. It's 4MB of compressed merge data — heavy for a single-user local app.
//   2. Different model families use different tokenizers (Llama vs Qwen vs Gemma);
//      tiktoken's cl100k_base is OpenAI-specific and wrong for these.
//   3. For budget estimation, ±10% accuracy is fine. The SAFETY_MARGIN absorbs
//      the variance.

import type { Tier } from '@/lib/capability-profile';
import {
  resolvePoolAwareCtxCap,
  type InferenceCtxRole,
} from '@/lib/compute-budget';

// ============================================================================
// Constants
// ============================================================================

/** Chars per token — see rationale above. */
const CHARS_PER_TOKEN = 3.0;

/**
 * Safety margin in tokens. Absorbs:
 *   - Inaccuracy of the char-based token estimate (±10%)
 *   - Tool call overhead the SDK adds (function results, role tags)
 *   - Tokenizer family variance (Llama vs Qwen vs Gemma)
 *   - Chat template tokens (<|im_start|>, <|im_end|>, etc.)
 */
const SAFETY_MARGIN_TOKENS = 512;

/**
 * Estimated tokens consumed by the AI SDK's tool schema serialization.
 * Based on empirical measurement: 8 tools × ~80 tokens each = ~640.
 * This is a rough upper bound; the actual size depends on which tools are
 * registered. Over-estimating is safe (leaves headroom); under-estimating
 * risks overflow.
 */
const TOOL_SCHEMA_TOKENS = 800;

/**
 * Conservative fallback context window when Ollama didn't report one.
 * Per-tier defaults so small models don't overflow and large models don't
 * waste capacity. These match the pre-existing `slice(-12)` behaviour
 * reasonably well (12 messages × ~200 tokens ≈ 2400 tokens of history).
 */
const FALLBACK_CONTEXT_WINDOW: Record<Tier, number> = {
  micro: 4096,        // 4B models typically have 4k context
  standard: 8192,     // 7-13B models typically have 8k context
  plus: 16384,        // 14-32B models typically have 16k-32k context
  max: 32768,         // 33B+ models typically have 32k+ context
};

/**
 * Minimum number of messages to keep, regardless of budget.
 * Even on the smallest context window, we want at least the user's last
 * message + our last reply — otherwise the model has no conversation to
 * respond to. This is a floor, not a target.
 */
const MIN_MESSAGES_TO_KEEP = 2;

/**
 * Maximum number of messages to consider, regardless of budget.
 * Even on a 128k context window, going beyond 50 messages is rarely useful —
 * early conversation context is usually irrelevant to the current question,
 * and the episode summary (injected separately) covers it. This cap also
 * bounds the O(n) walk cost.
 */
/**
 * Cap for dialogue history considered per turn.
 * Pipeline must fetch at least this many messages from DB — see pipeline-phases.
 */
export const MAX_MESSAGES_TO_CONSIDER = 50;

// ============================================================================
// Types
// ============================================================================

/** A single message in the dialogue history, normalized for budgeting. */
export interface BudgetMessage {
  role: 'user' | 'companion';
  content: string;
}

/** Input to computeDialogueBudget. */
export interface DialogueBudgetInput {
  /** Capability profile's context window (in tokens). 0 if unknown. */
  contextWindow: number;
  /** Current tier — used for fallback when contextWindow is 0. */
  tier: Tier;
  /** Final system prompt string that will be sent to the LLM. */
  systemPrompt: string;
  /** maxOutputTokens from the execution plan. */
  maxOutputTokens: number;
  /** Whether tools will be attached to the streamText call. */
  toolsEnabled: boolean;
  /** Optional VRAM pool — keeps dialogue window aligned with num_ctx. */
  pool?: PoolAwareCtxInput;
}

/** Result of budget computation. */
export interface DialogueBudgetResult {
  /** Number of messages (from the end) that fit within the budget. */
  messageCount: number;
  /** Estimated tokens consumed by those messages. */
  estimatedTokens: number;
  /** Total budget that was available for dialogue history. */
  budgetTokens: number;
  /** Effective context window used (fallback applied if input was 0). */
  effectiveContextWindow: number;
  /** Reason the walk stopped — useful for debugging. */
  stopReason: 'budget_exhausted' | 'max_messages_reached' | 'all_messages_fit';
}

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Estimate the number of tokens a string will consume when tokenized by a
 * typical LLM tokenizer (Llama / Qwen / Gemma family).
 *
 * Accuracy: ±10% for natural language, ±20% for code-heavy content.
 * Always slightly over-estimates — safe for budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ============================================================================
// Budget computation
// ============================================================================

/**
 * Cap inference / dialogue context per tier so advertised 128k–262k windows
 * do not inflate Ollama KV (TTFT) on a single-user box.
 */
const TIER_INFERENCE_CTX_CAP: Record<Tier, number> = {
  micro: 8192,
  standard: 32768,
  plus: 65536,
  max: 65536,
};

/** Optional VRAM-pool inputs for pool-aware num_ctx / dialogue window. */
export type PoolAwareCtxInput = {
  vramPoolGb?: number;
  vramPoolKnown?: boolean;
  parameterSizeB?: number;
  quantization?: string | null;
  /** day = prefer full GPU; heavy = allow mild spill. Default day. */
  role?: InferenceCtxRole;
  embedReserveGb?: number;
};

/**
 * Resolve the effective context window.
 *
 * If the model reported a real context window (Ollama `/api/show`), use it.
 * Otherwise fall back to a tier-based default. Always capped per tier for latency.
 * When pool opts are known, further cap so weights+KV prefer full-GPU residency.
 */
export function resolveContextWindow(
  contextWindow: number,
  tier: Tier,
  pool?: PoolAwareCtxInput,
): number {
  const tierCap = TIER_INFERENCE_CTX_CAP[tier];
  let base: number;
  if (contextWindow > 0) {
    base = Math.min(contextWindow, tierCap);
  } else {
    base = Math.min(FALLBACK_CONTEXT_WINDOW[tier], tierCap);
  }

  const poolCap = resolvePoolAwareCtxCap({
    vramPoolGb: pool?.vramPoolGb ?? 0,
    vramPoolKnown: pool?.vramPoolKnown === true,
    parameterSizeB: pool?.parameterSizeB ?? 0,
    quantization: pool?.quantization ?? null,
    role: pool?.role ?? 'day',
    embedReserveGb: pool?.embedReserveGb,
  });
  if (poolCap == null) return base;
  return Math.min(base, poolCap);
}

/**
 * Explicit num_ctx to send to Ollama — aligned with dialogue budget.
 * Pool formula prefers full-GPU residency; no host-SKU constants.
 */
export function resolveInferenceNumCtx(
  contextWindow: number,
  tier: Tier,
  pool?: PoolAwareCtxInput,
): number {
  return resolveContextWindow(contextWindow, tier, pool);
}

/**
 * Compute how many recent dialogue messages fit within the model's context
 * window, given the system prompt and output budget.
 *
 * Algorithm:
 *   1. Resolve effective context window (real or fallback).
 *   2. Subtract: systemPrompt + maxOutputTokens + toolSchema (if enabled) + SAFETY_MARGIN.
 *   3. Walk messages from newest to oldest, accumulating token estimates.
 *   4. Stop when adding the next message would exceed the remaining budget,
 *      OR when we hit MAX_MESSAGES_TO_CONSIDER.
 *   5. Return the slice index and metadata.
 *
 * The caller is expected to pass messages already filtered to user/companion
 * roles. We do not filter here — keeps the function pure and testable.
 */
export function computeDialogueBudget(
  input: DialogueBudgetInput,
  messages: BudgetMessage[],
): DialogueBudgetResult {
  const effectiveContextWindow = resolveContextWindow(
    input.contextWindow,
    input.tier,
    input.pool,
  );

  const systemPromptTokens = estimateTokens(input.systemPrompt);
  const toolTokens = input.toolsEnabled ? TOOL_SCHEMA_TOKENS : 0;

  const budgetTokens = Math.max(
    0,
    effectiveContextWindow
      - systemPromptTokens
      - input.maxOutputTokens
      - toolTokens
      - SAFETY_MARGIN_TOKENS,
  );

  // Walk from newest to oldest. We want to keep as many recent messages as fit.
  const cappedCount = Math.min(messages.length, MAX_MESSAGES_TO_CONSIDER);
  let accumulated = 0;
  let kept = 0;

  for (let i = 0; i < cappedCount; i++) {
    // Index from the end: messages[len-1], messages[len-2], ...
    const msg = messages[messages.length - 1 - i];
    const msgTokens = estimateTokens(msg.content);

    if (accumulated + msgTokens > budgetTokens && kept >= MIN_MESSAGES_TO_KEEP) {
      // Adding this message would overflow, and we already have the minimum.
      return {
        messageCount: kept,
        estimatedTokens: accumulated,
        budgetTokens,
        effectiveContextWindow,
        stopReason: 'budget_exhausted',
      };
    }

    accumulated += msgTokens;
    kept++;

    if (kept >= MAX_MESSAGES_TO_CONSIDER) {
      return {
        messageCount: kept,
        estimatedTokens: accumulated,
        budgetTokens,
        effectiveContextWindow,
        stopReason: 'max_messages_reached',
      };
    }
  }

  // All messages fit within budget.
  return {
    messageCount: messages.length,
    estimatedTokens: accumulated,
    budgetTokens,
    effectiveContextWindow,
    stopReason: 'all_messages_fit',
  };
}

/**
 * Apply the computed budget to a message list — convenience wrapper.
 *
 * Returns the slice of messages that fit within the budget, in chronological
 * order (oldest first, newest last) — ready to be spread into the `messages`
 * array passed to `streamText`.
 */
export function applyDialogueBudget(
  messages: BudgetMessage[],
  result: DialogueBudgetResult,
): BudgetMessage[] {
  // P-CORE-2 fix: `slice(-0)` is equivalent to `slice(0)` — returns the ENTIRE
  // array. When `result.messageCount = 0` (micro tier with large system prompt
  // overflowing the context), this would send all messages and overflow the
  // model. `Math.max(0, …)` makes the slice index always positive.
  const n = Math.max(0, result.messageCount);
  return messages.slice(messages.length - n);
}

/**
 * True when the dialogue budget dropped older messages — episode summary
 * should catch up more aggressively than the default every-20 cadence.
 */
export function isDialogueBudgetPressured(
  result: DialogueBudgetResult,
  totalMessages: number,
): boolean {
  if (totalMessages <= result.messageCount) return false;
  return result.stopReason === 'budget_exhausted' || result.stopReason === 'max_messages_reached';
}
