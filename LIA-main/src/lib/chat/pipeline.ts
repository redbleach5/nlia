import 'server-only';

// ============================================================================
// ChatPipeline — оркестрация chat message processing.
// ============================================================================
//
// Thin orchestrator: валидация → фазы → stream → response.
// Step logic lives in pipeline-phases.ts, pipeline-helpers.ts, pipeline-stream.ts.
//
// Decomposed 2026-07-08 (was 825 lines god function).

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { assessDisagreement } from '@/lib/personality';
import { getCognitiveParams } from '@/lib/capability-profile';
import { classifyTaskComplexity } from '@/lib/task-complexity';
import { planExecution, type CognitiveMode } from '@/lib/cognitive-depth';
import { saveMessage } from '@/lib/memory/episodes';
import {
  detectTrivialMessageFlags,
  runChatPreflight,
  perceiveEpisodeEmotion,
  resolveLiaDecision,
  persistUserMessageAndSideEffects,
  buildChatPromptBundle,
} from './pipeline-phases';
import { chooseModelForQuery } from '@/lib/chat/model-selection';
import { poolOptsFromProfile } from '@/lib/chat/inference-ctx';
import {
  resolvePendingChatAttachments,
  buildUserModelMessage,
  type ResolvedChatAttachment,
} from '@/lib/chat/attachments';
import { getModelName } from '@/lib/ollama';
import { runChatStreamText, wrapChatStreamResponse } from './pipeline-stream';

type ChatPipelineInput = {
  text: string;
  episodeId: string;
  mode: CognitiveMode;
  attachmentIds?: string[];
  /** AbortSignal от запроса — срабатывает когда клиент отключается (Stop button). */
  abortSignal?: AbortSignal;
};

type ChatPipelineResult = {
  response: Response;
};

/** Plain streaming response for hard safety blocks (no LLM). */
function ethicalBlockResponse(message: string, disagreementLevel: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(message));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Disagreement-B64': Buffer.from(disagreementLevel, 'utf8').toString('base64'),
    },
  });
}

export async function runChatPipeline(input: ChatPipelineInput): Promise<ChatPipelineResult | NextResponse> {
  const { text, episodeId, mode: userMode, attachmentIds, abortSignal } = input;
  const log = logger.context({ episodeId: episodeId.slice(0, 8), mode: userMode });
  log.info('chat', 'Chat request received', {
    textLength: text.length,
    textPreview: text.slice(0, 80),
    attachments: attachmentIds?.length ?? 0,
  });

  // ── 1. Pre-flight ──
  const preflightResult = await runChatPreflight(log);
  if (preflightResult instanceof NextResponse) return preflightResult;

  const attachmentResolve = await resolvePendingChatAttachments(episodeId, attachmentIds);
  if (!attachmentResolve.ok) {
    return NextResponse.json({ error: attachmentResolve.error }, { status: 400 });
  }
  const resolvedAttachments: ResolvedChatAttachment[] = attachmentResolve.attachments;

  // ── 2–4. Capability + complexity + plan ──
  const { profile } = await getCognitiveParams();
  const tier = profile?.tier ?? 'standard';
  const complexity = classifyTaskComplexity(text);
  const plan = planExecution({ mode: userMode, tier, complexity });
  log.info('chat', 'Execution plan', {
    tier, complexity, planMode: plan.mode, calls: plan.calls,
    deliberate: plan.deliberate, selfCheck: plan.selfCheck,
    toolsEnabled: plan.toolsEnabled, maxTokens: plan.maxTokens,
  });

  // ── 5. Perceive emotion ──
  const emotionResult = await perceiveEpisodeEmotion({ episodeId, text, log });
  if (emotionResult instanceof NextResponse) return emotionResult;
  const { episode, recentMessages, perceivedEmotion, triggers, storedMessageCount } = emotionResult;

  // ── 5b. Safety short-circuit (Cleanup Wave 2) ──
  // Hard guardrails must actually block — not only set a header while the model
  // still answers via liaDecision=help.
  const disagreement = assessDisagreement(text);
  if (disagreement.level === 'ethicalBlock') {
    const refusal = `Нет. ${disagreement.reason}`;
    log.warn('chat', 'Safety ethicalBlock — short-circuit', { reason: disagreement.reason });
    try {
      await saveMessage(episodeId, { role: 'user', content: text });
      await saveMessage(episodeId, { role: 'companion', content: refusal });
    } catch (e) {
      log.warn('chat', 'ethicalBlock persist failed (non-fatal)', {}, e);
    }
    return { response: ethicalBlockResponse(refusal, disagreement.level) };
  }

  // ── 6. Lia decision (fallback only — monologue LLM disabled for TTFT) ──
  const trivialFlags = detectTrivialMessageFlags(text);

  const { liaDecision, liaIntent, shouldSkipMonologue } = await resolveLiaDecision({
    text, tier, userMode, perceivedEmotion, recentMessages, trivialFlags,
    emotionTriggers: triggers, log,
    forceSkipMonologue: true,
  });

  // ── 7. Save user message + side effects ──
  const userMsg = await persistUserMessageAndSideEffects({
    episodeId, text, perceivedEmotion, liaDecision, liaIntent, shouldSkipMonologue, log,
    attachments: resolvedAttachments,
    attachmentIds: resolvedAttachments.map(a => a.id),
  });

  const modelChoice = await chooseModelForQuery(complexity, tier);
  const modelName = (modelChoice.usedSecondary || modelChoice.usedHeavy)
    ? modelChoice.modelName
    : await getModelName();
  const finalUserMessage = await buildUserModelMessage({
    text,
    attachments: resolvedAttachments,
    modelName,
  });

  // ── 8–9. Context + system prompt + messages ──
  const promptBundle = await buildChatPromptBundle({
    episodeId, text, userMode, tier, complexity, plan, profile, episode,
    recentMessages, perceivedEmotion, liaDecision, trivialFlags, storedMessageCount,
    log, abortSignal,
    finalUserMessage,
  });
  const {
    systemPrompt, coreMessages, webSearchContext, kbAnswerLocked, pinnedSourceIds,
  } = promptBundle;
  const disagreementLevel = disagreement.level;

  // ── 10. Main streamText (no deliberate pre-call) ──
  // H2 fix (2026-07-08): catch synchronous throws, return RU fallback.
  const streamError = { current: null as import('./pipeline-stream').StreamErrorSummary | null };
  let result;
  try {
    result = await runChatStreamText({
      systemPrompt, deliberateContext: '', coreMessages, userMode, tier, complexity, plan,
      webSearchContext, kbAnswerLocked, episodeId, text, perceivedEmotion, triggers,
      abortSignal, log, streamError, pinnedSourceIds,
      modelChoice,
      contextWindow: profile?.contextWindow ?? 0,
      pool: poolOptsFromProfile(profile),
    });
  } catch (e) {
    log.error('chat', 'runChatStreamText threw — returning fallback', {}, e instanceof Error ? e : undefined);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      response: new Response(JSON.stringify({ error: `Не удалось запустить модель: ${msg}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // ── 12. Response with metadata ──
  let response: Response;
  try {
    response = wrapChatStreamResponse({
      result, streamError, episodeId, userMessageId: userMsg.id, triggers,
      perceivedEmotion, disagreementLevel, tier, complexity, plan, profile,
    });
  } catch (e) {
    log.error('chat', 'wrapChatStreamResponse threw — returning fallback', {}, e instanceof Error ? e : undefined);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      response: new Response(JSON.stringify({ error: `Внутренняя ошибка при подготовке ответа: ${msg}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  return { response };
}

// Re-export phase helpers for tests and backwards compat.
export { formatStreamErrorForUser } from './pipeline-stream';
