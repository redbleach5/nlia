/**
 * Chat pipeline — single streamText with SSE event stream.
 *
 * Per docs/ARCHITECTURE.md § 9.1. This is the v3 simplification of v2's
 * pipeline-phases.ts (~19k LOC) into one continuous streamText call.
 *
 * M1 scope:
 *   - No tools (M5 adds tool-use)
 *   - No proactive web/KB search (model decides via tools in M5)
 *   - No deliberate / selfCheck (always off in v2; removed per § 2.5)
 *   - No emotion perception (uses NEUTRAL_EMOTION; M3 wires perceive)
 *   - No memory recall (M3)
 *
 * Emits ChatEvent SSE stream:
 *   - status    → "Думаю…" before first token
 *   - text_delta → as tokens stream
 *   - done      → on finish with usage stats
 *   - error     → on failure
 *
 * Persistence:
 *   - User message inserted BEFORE streamText
 *   - Companion message inserted AFTER streamText with full content + usage
 */

import { streamText, type ModelMessage } from "ai";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { getChatModel } from "../llm/ollama.js";
import { buildChatSystemPrompt } from "./system-prompt.js";
import { listMessages, insertMessage, buildAiMessages } from "../services/messages.js";
import { touchEpisode } from "../services/episodes.js";
import {
  getInlineResourcesForEpisode,
  buildAttachmentsContext,
} from "../workspace/service.js";
import { remember } from "../memory/vector.js";
import { extractAndSaveFacts } from "../memory/fact-extraction.js";
import {
  storeEmotionalMemory,
  shouldStoreEmotionalMemory,
} from "../memory/emotional-memory.js";
import { logger } from "../util/logger.js";
import { getCapabilityProfile } from "./capability-profile.js";
import { computeDialogueBudget } from "./context-budget.js";
import { generateEpisodeTitle } from "../memory/episode-title.js";
import { summarizeEpisode } from "../memory/summarization.js";
import { listMessages as listMsgs } from "../services/messages.js";
import { extractClaimedNameFromUtterance, listPeople, createPerson, resolvePersonFromUtterance } from "../memory/people.js";

import type { ChatEvent, ChatRequest, Resource } from "@lia/shared";


import type { EmotionalStateSnapshot, EmotionVector } from "../identity/emotional-state.js";


interface RunChatPipelineOpts extends ChatRequest {
  abortSignal?: AbortSignal;
}

/**
 * Run the chat pipeline and stream ChatEvents via SSE.
 *
 * Returns the Hono Response (the SSE stream). The caller (route handler)
 * must return this Response.
 */
export async function runChatPipeline(c: Context, opts: RunChatPipelineOpts): Promise<Response> {
  const { text, episodeId, abortSignal, attachmentIds } = opts;
  // Note: `mode` is accepted but currently unused — M5 routes agent mode to
  // the orchestrator instead of this pipeline. For M1 all chat goes here.
  const startedAt = Date.now();

  // ─── 1. Resolve inline attachments (M2) ────────────────────────────
  const attachments: Resource[] =
    attachmentIds && attachmentIds.length > 0
      ? getInlineResourcesForEpisode(episodeId, attachmentIds)
      : [];

  // ─── 2. Persist user message BEFORE inference ──────────────────────
  // Attachments are stored as JSON snapshot on the message row so the UI
  // can render them on reload without re-fetching from /api/resources.
  const attachmentMeta = attachments.map((r) => ({
    id: r.id,
    name: r.name,
    mimeType: r.config.mimeType ?? "application/octet-stream",
    kind:
      (r.config.mimeType ?? "").startsWith("image/")
        ? ("image" as const)
        : ("text" as const),
    sizeBytes: r.byteSize ?? 0,
  }));

  const userMsg = insertMessage({
    episodeId,
    role: "user",
    content: text,
    attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
  });
  touchEpisode(episodeId);

  // ─── 3. Build system prompt + messages ─────────────────────────────
  const history = listMessages(episodeId, 50);
  // Drop the just-inserted user message — we'll pass it via newUserText
  // so buildAiMessages can shape it correctly.
  const priorHistory = history.filter((m) => m.id !== userMsg.id);
  const aiMessages = buildAiMessages(priorHistory, text);

  // M3: get last emotional state from previous companion message for decay
  const lastCompanionMsg = [...priorHistory]
    .reverse()
    .find((m) => m.role === "companion" || m.role === "assistant");
  const lastEmotion = lastCompanionMsg?.emotionJson as EmotionVector | null;
  const lastTs = lastCompanionMsg?.createdAt ?? null;

  // Build attachments context block for system prompt (M2)
  const attachmentsContext = buildAttachmentsContext(attachments);

  let systemPrompt: string;
  let emotionalSnapshot: EmotionalStateSnapshot;
  let model: Awaited<ReturnType<typeof getChatModel>>;
  try {
    // Prompt build (may embed for recall) in parallel with model resolve
    const [promptResult, resolvedModel] = await Promise.all([
      buildChatSystemPrompt({
        episodeId,
        text,
        lastEmotion,
        lastTs,
      }),
      getChatModel(),
    ]);
    emotionalSnapshot = promptResult.emotionalSnapshot;
    // Append attachments context to the system prompt (after identity + memory)
    systemPrompt = attachmentsContext
      ? `${promptResult.systemPrompt}\n\n${attachmentsContext}`
      : promptResult.systemPrompt;
    model = resolvedModel;

    // Context budget trimming — drop oldest messages if they don't fit (per § 2.6)
    try {
      const profile = await getCapabilityProfile();
      // Cap history harder on weak tiers — prefill is the main cost on 7–8B
      const historyCap =
        profile.tier === "micro" ? 8 : profile.tier === "standard" ? 15 : 50;
      const cappedHistory =
        priorHistory.length > historyCap
          ? priorHistory.slice(-historyCap)
          : priorHistory;
      const budget = computeDialogueBudget(profile, systemPrompt, cappedHistory);
      if (budget.truncated || cappedHistory.length !== priorHistory.length) {
        logger.info(
          {
            episodeId,
            dropped: priorHistory.length - budget.selectedMessages.length,
            kept: budget.selectedMessages.length,
            tier: profile.tier,
          },
          "dialogue budget applied",
        );
        // Rebuild aiMessages with trimmed history
        aiMessages.length = 0;
        aiMessages.push(...buildAiMessages(budget.selectedMessages, text));
      }
    } catch (e) {
      logger.warn({ err: e, episodeId }, "context budget skipped (non-fatal)");
    }
  } catch (err) {

    logger.error({ err, episodeId }, "chat pipeline: preflight failed");
    return emitError(c, "failed to initialise model");
  }

  // ─── 4. streamText + SSE ───────────────────────────────────────────
  // Hono's streamSSE returns a Response; we return it to the caller.
  return streamSSE(c, async (stream) => {
    // Status event before first token (per § 9.2)
    await writeEvent(stream, { type: "status", label: "Думаю…", ts: Date.now() });

    let fullText = "";
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let finishReason: string | undefined;
    let pipelineErr: string | undefined;

    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: aiMessages as ModelMessage[],
        temperature: 0.7,
        abortSignal,
        onError: ({ error }) => {
          pipelineErr = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, episodeId }, "streamText error");
        },
      });

      // Stream text deltas
      for await (const part of result.fullStream) {
        if (abortSignal?.aborted) break;

        switch (part.type) {
          case "text-delta": {
            const delta = part.text;
            if (delta) {
              fullText += delta;
              await writeEvent(stream, { type: "text_delta", text: delta, ts: Date.now() });
            }
            break;
          }
          case "error": {
            const err = part.error;
            pipelineErr = err instanceof Error ? err.message : String(err);
            logger.error({ err, episodeId }, "fullStream error part");
            break;
          }
          case "finish": {
            // AI SDK v7 TextStreamFinishPart: { usage, finishReason, ... }
            // usage is the Usage object with inputTokens/outputTokens.
            const u = (part as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
            tokensIn = u?.inputTokens;
            tokensOut = u?.outputTokens;
            finishReason = (part as { finishReason?: string }).finishReason;
            break;
          }
          default:
            // Other part types (tool-call, tool-result, etc.) — M5+ concern
            break;
        }
      }

      if (pipelineErr) {
        await writeEvent(stream, { type: "error", message: pipelineErr, ts: Date.now() });
        return;
      }

      // ─── 5. Persist companion message ────────────────────────────
      const durationMs = Date.now() - startedAt;
      const finalText = fullText || "";
      if (finalText) {
        insertMessage({
          episodeId,
          role: "companion",
          content: finalText,
          emotionJson: emotionalSnapshot.vector, // M3: persist emotion snapshot
          tokensIn,
          tokensOut,
          durationMs,
        });

        // ─── 6. Background memory writes (M3) ──────────────────────
        // Non-blocking — don't wait for these before sending the done event.
        //  a. Vector memory: store the dialogue turn for semantic recall
        //  b. Fact extraction: LLM call to extract user/episode facts
        //  c. Emotional memory: store if significant emotional moment
        void runBackgroundMemoryWrites({
          episodeId,
          userText: text,
          companionText: finalText,
          emotionalSnapshot,
        }).catch((e) =>
          logger.warn({ err: e, episodeId }, "background memory writes failed (non-fatal)"),
        );
      }

      await writeEvent(stream, {
        type: "done",
        ts: Date.now(),
        tokensIn,
        tokensOut,
        durationMs,
      });
      logger.info(
        { episodeId, finishReason, tokensIn, tokensOut, durationMs, chars: finalText.length },
        "chat pipeline complete",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, episodeId }, "chat pipeline exception");
      await writeEvent(stream, { type: "error", message: msg, ts: Date.now() });
    }
  });
}

// ─── SSE helpers ──────────────────────────────────────────────────────
// Hono's streamSSE callback receives a StreamingApi; we use its writeSSE method.
type SseStream = Parameters<Parameters<typeof streamSSE>[1]>[0];

async function writeEvent(stream: SseStream, ev: ChatEvent): Promise<void> {
  await stream.writeSSE({ data: JSON.stringify(ev) });
}

async function emitError(c: Context, message: string): Promise<Response> {
  return streamSSE(c, async (stream) => {
    await writeEvent(stream, { type: "error", message, ts: Date.now() });
  });
}

// ─── Background memory writes (M3) ────────────────────────────────────
/**
 * After a companion turn completes, trigger background memory writes:
 *   a. Vector memory: store the dialogue turn for semantic recall
 *   b. Fact extraction: LLM call to extract user/episode facts
 *   c. Emotional memory: store if significant emotional moment
 *
 * All non-blocking — the chat response is already sent. Failures are logged
 * but never propagate to the user.
 */
async function runBackgroundMemoryWrites(params: {
  episodeId: string;
  userText: string;
  companionText: string;
  emotionalSnapshot: EmotionalStateSnapshot;
}): Promise<void> {
  const { episodeId, userText, companionText, emotionalSnapshot } = params;

  // a. Vector memory: store the dialogue for future semantic recall
  await remember({
    episodeId,
    sourceType: "dialogue",
    text: `Пользователь: ${userText.slice(0, 500)}\nЛия: ${companionText.slice(0, 500)}`,
  });

  // b. Fact extraction (LLM call — may be slow, fully background)
  await extractAndSaveFacts({
    userMessage: userText,
    liaMessage: companionText,
    episodeId,
  });

  // c. People: auto-extract claimed name from user message (v2 port)
  // Only runs if no person exists yet or user claims a new name
  try {
    const claimedName = extractClaimedNameFromUtterance(userText);
    if (claimedName) {
      const people = listPeople();
      const existing = resolvePersonFromUtterance(userText, people);
      if (!existing) {
        createPerson({ displayName: claimedName, isDefault: people.length === 0 });
        logger.info({ episodeId, name: claimedName }, "person auto-extracted from chat");
      }
    }
  } catch (e) {
    logger.warn({ err: e, episodeId }, "people auto-extraction failed (non-fatal)");
  }

  // d. Emotional memory: store if the perceive triggers indicate a significant moment
  const emotionDecision = shouldStoreEmotionalMemory(
    emotionalSnapshot.triggers,
    emotionalSnapshot.vector,
  );
  if (emotionDecision.store) {
    storeEmotionalMemory({
      episodeId,
      emotion: emotionDecision.emotion,
      intensity: emotionDecision.intensity,
      trigger: `Triggers: ${emotionalSnapshot.triggers.join(", ")}`,
      context: `User: ${userText.slice(0, 500)}\nLia: ${companionText.slice(0, 300)}`,
      emotionVector: emotionalSnapshot.vector,
    });
  }

  // e. Auto-generate episode title (if still untitled and has some history)
  try {
    await generateEpisodeTitle(episodeId);
  } catch (e) {
    logger.warn({ err: e, episodeId }, "episode title generation failed (non-fatal)");
  }

  // f. Summarization: generate if episode has ≥10 messages and no summary yet
  try {
    const count = listMsgs(episodeId, 1).length > 0 ? listMsgs(episodeId, 100).length : 0;
    if (count >= 10) {
      await summarizeEpisode(episodeId);
    }
  } catch (e) {
    logger.warn({ err: e, episodeId }, "summarization failed (non-fatal)");
  }
}


