import 'server-only';

import { embed } from '@/lib/ollama';
import { insertVectorMemory, searchVectorsInEpisode } from '@/lib/db-vec';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import { escapeForPrompt } from '@/lib/infra/prompt-safety';

type VectorSourceType = 'dialogue' | 'summary' | 'fact' | 'emotional';

export async function remember(params: {
  episodeId: string;
  sourceType: Exclude<VectorSourceType, 'emotional'>;
  text: string;
}): Promise<void> {
  try {
    const embedding = await embed(params.text);
    insertVectorMemory({
      id: randomUUID(),
      episodeId: params.episodeId,
      sourceType: params.sourceType,
      text: params.text,
      embedding,
    });
  } catch (e) {
    logger.warn('memory', 'remember failed (non-fatal)', {}, e);
  }
}

export async function recall(params: {
  episodeId: string;
  query: string;
  limit?: number;
  minSimilarity?: number;
  sourceTypes?: Array<'dialogue' | 'summary' | 'fact'>;
}): Promise<Array<{ sourceType: string; text: string; similarity: number }>> {
  const limit = params.limit ?? 5;
  const minSimilarity = params.minSimilarity ?? 0.3;
  const sourceTypes = params.sourceTypes ?? ['dialogue', 'fact', 'summary'];

  try {
    const queryEmbedding = await embed(params.query);
    const merged: Array<{ sourceType: string; text: string; similarity: number }> = [];

    for (const sourceType of sourceTypes) {
      const hits = searchVectorsInEpisode({
        episodeId: params.episodeId,
        queryEmbedding,
        limit,
        minSimilarity,
        sourceType,
      });
      merged.push(...hits.map(h => ({
        sourceType: h.sourceType,
        text: h.text,
        similarity: h.similarity,
      })));
    }

    merged.sort((a, b) => b.similarity - a.similarity);
    return merged.slice(0, limit);
  } catch (e) {
    logger.warn('memory', 'recall failed (non-fatal)', {}, e);
    return [];
  }
}

export function formatVectorHitsForPrompt(hits: Array<{ sourceType: string; text: string; similarity: number }>): string {
  if (hits.length === 0) return '';
  return hits
    .map(h => `[${h.sourceType}, sim=${h.similarity.toFixed(2)}]\n${escapeForPrompt(h.text.slice(0, 500))}`)
    .join('\n---\n');
}

