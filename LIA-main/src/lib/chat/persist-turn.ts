import 'server-only';

import { logger } from '@/lib/logger';
import { saveMessage } from '@/lib/memory/episodes';
import { remember } from '@/lib/memory/vector';
import { extractAndSaveFacts } from '@/lib/memory/fact-extraction';
import type { ExecutionPlan } from '@/lib/cognitive-depth';
import type { EmotionVector } from '@/lib/personality';

type PersistChatTurnParams = {
  fullText: string;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  startTime: number;
  episodeId: string;
  text: string;
  perceivedEmotion: EmotionVector;
  triggers: string[];
  plan: ExecutionPlan;
  log: ReturnType<typeof logger.context>;
};

export async function persistChatTurn(params: PersistChatTurnParams): Promise<void> {
  const {
    fullText, usage, startTime, episodeId, text, perceivedEmotion,
    plan: _plan, log,
  } = params;

  const durationMs = Date.now() - startTime;
  log.info('chat', `Response finished (${durationMs}ms)`, {
    responseLength: fullText.length,
    responsePreview: fullText.slice(0, 120),
    tokensIn: usage?.inputTokens,
    tokensOut: usage?.outputTokens,
    cachedTokensIn: (usage as Record<string, unknown> | undefined)?.cachedInputTokens ?? undefined,
  });

  try {
    await saveMessage(episodeId, {
      role: 'companion',
      content: fullText,
      emotionJson: JSON.stringify(perceivedEmotion),
      tokensIn: usage?.inputTokens ?? null,
      tokensOut: usage?.outputTokens ?? null,
      durationMs,
    });
  } catch (e) {
    log.error('chat', 'Failed to save companion message', {}, e);
  }

  remember({
    episodeId,
    sourceType: 'dialogue',
    text: `User: ${text}\nLia: ${fullText.slice(0, 500)}`,
  }).catch((e) => {
    log.warn('chat', 'remember() failed — dialogue vector not stored (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
  });

  // Emotional anchors: recording stopped (prompt inject already removed).
  // Keep emotional-memory.ts for opt-in reflection / future experiments.

  // Fire-and-forget: awaiting fact extraction holds the GPU/LLM for the next turn.
  void extractAndSaveFacts({ userMessage: text, liaMessage: fullText, episodeId }).catch((e) => {
    log.warn('chat', 'Fact extraction failed (non-fatal)', {}, e);
  });
}
