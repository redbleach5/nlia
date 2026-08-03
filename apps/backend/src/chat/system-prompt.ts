/**
 * System prompt builder for chat pipeline.
 *
 * Per docs/ARCHITECTURE.md § 9.1 + § 9.3 + § 10.5. The system prompt is the
 * KV-cache prefix — keep STATIC_CORE at the top so Ollama can reuse the cache.
 *
 * Structure (top to bottom):
 *   1. STATIC_CORE          — stable response rules (cached prefix)
 *   2. Character summary    — Lia identity (cached prefix)
 *   3. Self-awareness       — internal context (cached prefix)
 *   4. Emotional state      — current context (changes per turn, M3: perceive)
 *   5. Global facts         — user profile (name, profession, …)
 *   6. Episode facts        — per-episode context (current project, …)
 *   7. Vector recall hits   — semantically relevant past dialogue (M3)
 *   8. Emotional memories   — significant emotional moments (M3)
 *
 * M3: full memory stack. M1 had only 1-6 with NEUTRAL_EMOTION.
 */

import { STATIC_CORE } from "../identity/static-core.js";
import { getCharacterSummary } from "../identity/character.js";
import { generateChatSelfAwareness } from "../identity/self-awareness.js";
import {
  perceiveAndSnapshot,
  type EmotionalStateSnapshot,
  type EmotionVector,
} from "../identity/emotional-state.js";
import {
  loadGlobalFacts,
  loadEpisodeFacts,
  formatGlobalFactsForPrompt,
  formatEpisodeFactsForPrompt,
} from "../memory/prompt-helpers.js";
import { recall, formatVectorHitsForPrompt, type VectorHit } from "../memory/vector.js";
import {
  listEmotionalMemories,
  formatEmotionalMemoriesForPrompt,
} from "../memory/emotional-memory.js";
import { logger } from "../util/logger.js";
import { GROUNDING } from "../identity/grounding.js";
import { classifyTaskComplexity } from "./task-complexity.js";
import { getCapabilityProfile } from "./capability-profile.js";
import { runInnerMonologue, shouldRunInnerMonologue } from "../identity/inner-monologue.js";
import { formatDecisionForPrompt } from "../identity/decision.js";

export interface BuildSystemPromptOpts {

  episodeId: string;
  /** User's message text (used for perceive + vector recall query) */
  text: string;
  /** Optional emotional vector override (M3: if null, derives from perceive) */
  emotion?: EmotionVector;
  /** Last emotional state from previous message (for decay) */
  lastEmotion?: EmotionVector | null;
  /** Last message timestamp (for decay calculation) */
  lastTs?: number | null;
}

export interface SystemPromptResult {
  systemPrompt: string;
  emotionalSnapshot: EmotionalStateSnapshot;
  vectorHits: VectorHit[];
}

/**
 * Build the chat system prompt with all memory layers.
 *
 * M3: includes perceive-based emotional state + vector recall + emotional memories.
 */
export async function buildChatSystemPrompt(
  opts: BuildSystemPromptOpts,
): Promise<SystemPromptResult> {
  // ─── 4. Emotional state (perceive from user message + decay) ──────
  const emotionalSnapshot = perceiveAndSnapshot(
    opts.text,
    opts.lastEmotion ?? null,
    opts.lastTs ?? null,
  );

  // ─── 5-6. Global + episode facts ──────────────────────────────────
  const globalFacts = loadGlobalFacts();
  const episodeFacts = loadEpisodeFacts(opts.episodeId);

  // ─── 7. Vector recall (semantic search for relevant past dialogue) ──
  // Skip on trivial greetings — embed before TTFB hurts weak single-GPU setups.
  let vectorHits: VectorHit[] = [];
  const complexity = classifyTaskComplexity(opts.text);
  if (complexity !== "trivial") {
    try {
      vectorHits = await recall({
        episodeId: opts.episodeId,
        query: opts.text,
        limit: complexity === "simple" ? 3 : 5,
        minSimilarity: 0.3,
        sourceTypes: ["dialogue", "fact", "summary"],
      });
    } catch (e) {
      logger.warn({ err: e, episodeId: opts.episodeId }, "vector recall failed (non-fatal)");
    }
  }

  // ─── 8. Emotional memories (significant past moments) ─────────────
  const emotionalMemories = listEmotionalMemories(opts.episodeId, { limit: 5 });

  // ─── Assemble prompt ──────────────────────────────────────────────
  const sections: string[] = [
    STATIC_CORE,
    "",
    "=== КТО ТЫ ===",
    getCharacterSummary(),
    "",
    generateChatSelfAwareness(),
    "",
    "=== ТВОЁ ЭМОЦИОНАЛЬНОЕ СОСТОЯНИЕ ===",
    emotionalSnapshot.description,
  ];

  // Global facts
  const globalFactsStr = formatGlobalFactsForPrompt(globalFacts);
  if (globalFactsStr) {
    sections.push("", "=== ЧТО ТЫ ЗНАЕШЬ ПРО СОБЕСЕДНИКА ===", globalFactsStr);
  }

  // Episode facts
  const episodeFactsStr = formatEpisodeFactsForPrompt(episodeFacts);
  if (episodeFactsStr) {
    sections.push("", "=== КОНТЕКСТ ЭТОГО РАЗГОВОРА ===", episodeFactsStr);
  }

  // Vector recall hits
  const vectorHitsStr = formatVectorHitsForPrompt(vectorHits);
  if (vectorHitsStr) {
    sections.push("", "=== РЕЛЕВАНТНЫЕ ВОСПОМИНАНИЯ (из векторной памяти) ===", vectorHitsStr);
  }

  // Emotional memories
  const emotionalMemoriesStr = formatEmotionalMemoriesForPrompt(emotionalMemories);
  if (emotionalMemoriesStr) {
    sections.push("", emotionalMemoriesStr);
  }

  // ─── 9. Grounding (anti-hallucination constraints) ────────────────
  sections.push(
    "",
    "=== ПРАВИЛА ЧЕСТНОСТИ ===",
    GROUNDING.noFabricateFromText,
    GROUNDING.noFabricateFromFacts,
    GROUNDING.noFabricateFromKb,
    GROUNDING.citeSources,
    GROUNDING.noConfabulation,
  );

  // ─── 10. Inner monologue (optional — complex/research on plus/max tier) ──
  // Only fetch capability profile when complexity could enable monologue —
  // avoids duplicate /api/show on every "привет" for weak models.
  if (complexity === "complex" || complexity === "research") {
    try {
      const profile = await getCapabilityProfile();

      if (shouldRunInnerMonologue({ complexity, tier: profile.tier })) {
        const decision = await runInnerMonologue({
          userMessage: opts.text,
          episodeId: opts.episodeId,
          emotionDescription: emotionalSnapshot.description,
        });
        if (decision) {
          sections.push("", formatDecisionForPrompt(decision));
        }
      }
    } catch (e) {
      logger.warn({ err: e, episodeId: opts.episodeId }, "inner monologue skipped (non-fatal)");
    }
  }

  return {
    systemPrompt: sections.join("\n"),
    emotionalSnapshot,
    vectorHits,
  };
}

