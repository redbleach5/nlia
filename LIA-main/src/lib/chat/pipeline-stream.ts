import 'server-only';

// ============================================================================
// Chat pipeline streaming — extracted from pipeline.ts (2026-07-08).
// ============================================================================

import { streamText, isStepCount, type ModelMessage } from 'ai';
import { getChatModel, getModelName, setOllamaNumCtx, setOllamaKeepAlive } from '@/lib/ollama';
import { buildChatTools } from '@/lib/tools';
import { summarizeLlmError } from '@/lib/llm/error-summary';
import type { ModelChoice } from '@/lib/chat/model-selection';
import type { Tier } from '@/lib/capability-profile';
import type { TaskComplexity } from '@/lib/task-complexity';
import { resolveModelToolsSupport } from '@/lib/llm/tool-support';
import { resolveInferenceNumCtx, type PoolAwareCtxInput } from '@/lib/chat/context-budget';
import { decideChatTools } from './chat-tools';
import { persistChatTurn } from './persist-turn';
import { encodeStreamErrorMessage } from './stream-error';
import type { CognitiveMode, ExecutionPlan } from '@/lib/cognitive-depth';
import type { EmotionVector } from '@/lib/personality';
import type { RunnerLogger } from './pipeline-phases';

export type StreamErrorSummary = {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
};

export type StreamErrorHolder = { current: StreamErrorSummary | null };

export function formatStreamErrorForUser(err: StreamErrorSummary): string {
  const statusCode = err.statusCode;
  let msg: string;
  if (statusCode === 403) {
    msg = 'Не удалось подключиться к LLM-провайдеру (403 Forbidden). ' +
      'Возможные причины:\n' +
      '• Невалидный API ключ — проверь в Настройках → Модель\n' +
      '• IP заблокирован (Cloudflare geo-block) — попробуй VPN\n' +
      '• Срок действия ключа истёк';
  } else if (statusCode === 429) {
    msg = 'Слишком много запросов (429). Подожди минуту и попробуй снова. ' +
      (err.isRetryable ? 'Запрос можно повторить.' : '');
  } else if (statusCode && statusCode >= 500) {
    msg = `Сервер LLM вернул ошибку ${statusCode}. Попробуй через минуту.`;
  } else if (statusCode === 401) {
    msg = 'Невалидный API ключ. Открой Настройки → Модель и проверь ключ.';
  } else if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
    msg = 'Не удалось подключиться к Ollama. Запусти `ollama serve` или проверь URL в Настройках → Модель.';
  } else if (/does not support tools/i.test(err.message)) {
    msg = 'Эта модель в Ollama не умеет вызывать инструменты (web_search, KB, …). ' +
      'Для чата без tools ок; для поиска/агента выбери модель с tools в Настройки → Модель. ' +
      `(${err.message.slice(0, 120)})`;
  } else if (/pre-tokenizer|error loading model|llama-server process has terminated/i.test(err.message)) {
    msg = 'Ollama не смогла загрузить модель (часто: старый Ollama или несовместимый GGUF). ' +
      'Обнови Ollama с ollama.com/download или выбери другую модель в Настройки → Модель. ' +
      `(${err.message.slice(0, 140)})`;
  } else {
    msg = `Не удалось получить ответ от модели: ${err.message.slice(0, 200)}`;
  }
  // Sentinel so the client treats this as an error toast, not Lia's voice.
  return encodeStreamErrorMessage(msg);
}

export type StreamTextLike = {
  toTextStreamResponse: (opts?: { headers?: Record<string, string> }) => Response;
};

export async function runChatStreamText(params: {
  systemPrompt: string;
  deliberateContext: string;
  coreMessages: ModelMessage[];
  userMode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
  plan: ExecutionPlan;
  webSearchContext: string | undefined;
  kbAnswerLocked: boolean;
  episodeId: string;
  text: string;
  perceivedEmotion: EmotionVector;
  triggers: string[];
  abortSignal?: AbortSignal;
  log: RunnerLogger;
  streamError: StreamErrorHolder;
  /** Episode workspace KB pin — hard-filters search_sources. */
  pinnedSourceIds?: string[];
  /** Precomputed in pipeline — avoid second chooseModelForQuery. */
  modelChoice: ModelChoice;
  /** From capability profile — drives Ollama num_ctx. */
  contextWindow?: number;
  /** VRAM pool — caps num_ctx for full-GPU residency. */
  pool?: PoolAwareCtxInput;
}) {
  const {
    systemPrompt, deliberateContext, coreMessages, userMode, tier, complexity, plan,
    webSearchContext, kbAnswerLocked, episodeId, text, perceivedEmotion, triggers,
    abortSignal, log, streamError, pinnedSourceIds, modelChoice,
    contextWindow = 0,
    pool,
  } = params;

  const tools = buildChatTools({ pinnedSourceIds });

  const model = await getChatModel(
    modelChoice.usedSecondary || modelChoice.usedHeavy
      ? modelChoice.modelName
      : undefined,
  );
  const startTime = Date.now();
  const modelName = (modelChoice.usedSecondary || modelChoice.usedHeavy)
    ? modelChoice.modelName
    : await getModelName();
  // Prefer Ollama capabilities + heuristics — avoids AI_APICallError
  // "model does not support tools" (e.g. dolphin-mistral-nemo on Ollama).
  const toolsSupported = await resolveModelToolsSupport(modelName);

  if (modelChoice.usedSecondary) {
    log.info('chat', 'Using secondary (small) model for trivial query', {
      model: modelName,
      reason: modelChoice.reason,
    });
  }
  if (modelChoice.usedHeavy) {
    log.info('chat', 'Using heavy model for hard query', {
      model: modelName,
      reason: modelChoice.reason,
    });
  }

  const rawTimeout = parseInt(process.env.LIA_LLM_TIMEOUT_MS || '180000', 10);
  const LLM_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 180_000;
  const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const combinedSignal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;

  const useChatTools = decideChatTools({
    planToolsEnabled: plan.toolsEnabled,
    toolsSupported,
    kbAnswerLocked,
    webSearchContext,
    complexity,
  });

  // Tool-round budget: each search/fetch is a step; leave room for a final
  // text synthesis after tools. With budget=3, search→search→fetch often stops
  // mid-sentence ("сейчас найду…") with no answer. Standard needs ≥5.
  const toolRoundBudget = userMode === 'agent'
    ? (tier === 'max' ? 8 : tier === 'plus' ? 6 : 5)
    : (tier === 'max' ? 7 : tier === 'plus' ? 6 : 5);

  const numCtx = resolveInferenceNumCtx(contextWindow, tier, pool);
  log.debug('chat', 'Ollama num_ctx', {
    numCtx,
    contextWindow,
    tier,
    vramPoolGb: pool?.vramPoolGb,
    vramPoolKnown: pool?.vramPoolKnown,
  });
  setOllamaNumCtx(numCtx);
  // Heavy escalate: short keep_alive so day residency is not displaced indefinitely.
  if (modelChoice.usedHeavy) {
    setOllamaKeepAlive('0');
    log.info('chat', 'Heavy residency: keep_alive=0', { model: modelName });
  }

  return streamText({
    model,
    system: systemPrompt + (deliberateContext ? `\n\nВНУТРЕННИЙ АНАЛИЗ:\n${deliberateContext}` : ''),
    messages: coreMessages,
    tools: useChatTools ? tools : undefined,
    stopWhen: useChatTools
      ? isStepCount(toolRoundBudget)
      : isStepCount(1),
    // Force a text-only last step so we don't stop mid-tool-loop with
    // "Отлично, нашла… сейчас найду…" and no real answer (prod regression).
    prepareStep: useChatTools
      ? async ({ stepNumber }) => {
          if (stepNumber >= toolRoundBudget - 1) {
            return { toolChoice: 'none' as const };
          }
          return undefined;
        }
      : undefined,
    temperature: kbAnswerLocked ? 0.35 : 0.7,
    maxOutputTokens: plan.maxTokens,
    topP: 0.9,
    abortSignal: combinedSignal,
    onError: (error) => {
      const summary = summarizeLlmError(error);
      streamError.current = summary;
      log.error('chat', 'streamText onError', { ...summary });
    },
    onFinish: async ({ text: fullText, usage }) => {
      setOllamaNumCtx(undefined);
      setOllamaKeepAlive(undefined);
      await persistChatTurn({
        fullText, usage, startTime, episodeId, text, perceivedEmotion, triggers,
        plan, log,
      });
    },
  });
}

export function wrapChatStreamResponse(params: {
  result: StreamTextLike;
  streamError: StreamErrorHolder;
  episodeId: string;
  userMessageId: string;
  triggers: string[];
  perceivedEmotion: EmotionVector;
  disagreementLevel: string;
  tier: Tier;
  complexity: TaskComplexity;
  plan: ExecutionPlan;
  profile: { modelSize?: number; contextWindow?: number } | null;
}): Response {
  const {
    result, streamError, episodeId, userMessageId, triggers, perceivedEmotion,
    disagreementLevel, tier, complexity, plan, profile,
  } = params;

  const encodeB64 = (s: string): string => {
    try { return Buffer.from(s, 'utf-8').toString('base64'); } catch { return ''; }
  };

  const isProd = process.env.NODE_ENV === 'production';
  const debugHeaders: Record<string, string> = isProd ? {} : {
    'X-Tier': tier,
    'X-Complexity': complexity,
    'X-Mode': plan.mode,
    'X-Calls': String(plan.calls),
    'X-Deliberate': String(plan.deliberate),
    'X-SelfCheck': String(plan.selfCheck),
    'X-ModelSize': String(profile?.modelSize ?? 0),
  };

  const originalResponse = result.toTextStreamResponse({
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Episode-Id': episodeId,
      'X-Message-Id': userMessageId,
      ...debugHeaders,
      'X-Triggers-B64': encodeB64(triggers.join(',').slice(0, 200)),
      'X-Emotion-B64': encodeB64(JSON.stringify(perceivedEmotion)),
      'X-Disagreement-B64': encodeB64(disagreementLevel),
    },
  });

  const originalBody = originalResponse.body;
  // H1 fix (2026-07-08): previously the wrapped ReadableStream defined only
  // `start(controller)` — no `cancel()` hook. When the client disconnected,
  // the runtime cancelled our wrapped stream, but the inner `reader.read()`
  // loop kept pulling bytes from `originalBody` (the streamText response)
  // until that stream ended. That wasted CPU and delayed GC. Now we track an
  // `aborted` flag and provide a `cancel()` hook that releases the reader.
  let aborted = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const wrappedBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      // M15 fix: ensure the fallback message is enqueued at most once even if
      // the catch block races with the bytesReceived===0 branch.
      let sentFallback = false;
      const enqueueFallback = (msg: string) => {
        if (sentFallback) return;
        sentFallback = true;
        try { controller.enqueue(new TextEncoder().encode(msg)); } catch { /* controller closed */ }
      };
      let bytesReceived = 0;
      try {
        if (!originalBody) {
          enqueueFallback(
            streamError.current
              ? formatStreamErrorForUser(streamError.current)
              : encodeStreamErrorMessage('Не удалось получить ответ от модели. Проверь настройки LLM-провайдера.'),
          );
          controller.close();
          return;
        }
        reader = originalBody.getReader();
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytesReceived += value.byteLength;
            controller.enqueue(value);
          }
        }
        if (aborted) {
          // Client disconnected — drop everything, do not enqueue fallback.
          return;
        }
        if (bytesReceived === 0 || streamError.current) {
          enqueueFallback(
            streamError.current
              ? formatStreamErrorForUser(streamError.current)
              : encodeStreamErrorMessage(
                'Модель вернула пустой ответ. Возможно, превышен rate limit или невалидный API ключ.',
              ),
          );
        }
        controller.close();
      } catch (e) {
        if (aborted) return;
        const msg = streamError.current
          ? formatStreamErrorForUser(streamError.current)
          : encodeStreamErrorMessage(`Stream прерван: ${e instanceof Error ? e.message : String(e)}`);
        enqueueFallback(msg);
        try { controller.close(); } catch { /* already closed */ }
      } finally {
        // Release the reader lock if we still hold it.
        if (reader) {
          try { reader.releaseLock(); } catch { /* already released */ }
        }
      }
    },
    async cancel() {
      // Called by the runtime when the downstream consumer (client) cancels.
      aborted = true;
      if (reader) {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    },
  });

  return new Response(wrappedBody, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}
