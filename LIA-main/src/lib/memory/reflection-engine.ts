import 'server-only';

// ============================================================================
// ReflectionEngine — периодическая консолидация эмоциональной памяти.
// ============================================================================
//
// Проблема: EmotionalMemory накапливает якоря на каждое сообщение пользователя.
// Со временем их становятся десятки/сотни. Векторный поиск по ним деградирует —
// похожие якоря дублируются, recall становится шумным.
//
// Решение: периодически (раз в 6 часов или когда >20 unconsolidated anchors)
// LLM консолидирует группу похожих якорей в один summary anchor:
//   - Берём все unconsolidated anchors
//   - Группируем по эмоции + семантической близости (через embeddings)
//   - Для каждой группы LLM генерирует summary: "Пользователь часто
//     раздражается когда обсуждаем X, особенно в контексте Y"
//   - Создаём новый EmotionalMemory с consolidated=true, sourceIds=JSON array
//     исходных anchor IDs
//   - Помечаем исходные anchors как consolidated=true; pruneEmotionalMemories
//     позже удаляет старые source-якоря (summaries с sourceIds сохраняются)
//
// Recall потом берёт consolidated summaries — они обобщённые,
// не дублируют друг друга. При необходимости можно развернуть до исходных
// через sourceIds (пока source ещё не pruned).
//
// Запускается на server startup + каждые 6 часов. HMR-safe через globalThis.
// Controlled by LIA_REFLECTION_ENGINE env var (default: OFF — opt-in with =true).

import { db } from '@/lib/db';
import { embed } from '@/lib/ollama';
import { generateText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { logger } from '@/lib/logger';

const REFLECTION_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const MIN_ANCHORS_TO_CONSOLIDATE = 20;  // не запускаем если меньше этого числа
const MAX_ANCHORS_PER_GROUP = 10;  // не больше 10 anchors в одной LLM консолидации
const SIMILARITY_THRESHOLD = 0.75;  // cosine similarity для группировки

const g = globalThis as unknown as {
  __lia_reflection_timer__?: NodeJS.Timeout;
  __lia_reflection_initial_timer__?: NodeJS.Timeout;
  __lia_reflection_running__?: boolean;
};

/**
 * Запустить periodic reflection.
 * Вызывается на server startup. Idempotent. HMR-safe.
 *
 * P3-9 fix: recursive setTimeout instead of setInterval.
 * setInterval fires every intervalMs regardless of whether the previous
 * cycle completed — concurrent cycles could corrupt data (duplicate
 * consolidation, orphaned vec entries). Recursive setTimeout schedules the
 * next cycle ONLY after the current one finishes.
 */
export function startReflectionEngine(): void {
  if (g.__lia_reflection_timer__ || g.__lia_reflection_initial_timer__) {
    logger.debug('memory', 'Reflection engine already running, skipping');
    return;
  }
  g.__lia_reflection_running__ = true;

  // Recursive setTimeout — schedules next cycle ONLY after current finishes.
  const scheduleNext = (): void => {
    if (!g.__lia_reflection_running__) return;
    g.__lia_reflection_timer__ = setTimeout(async () => {
      g.__lia_reflection_timer__ = undefined;
      try {
        await runReflection();
      } catch (e) {
        logger.warn('memory', 'Reflection cycle failed', {}, e);
      }
      scheduleNext();
    }, REFLECTION_INTERVAL_MS);
    g.__lia_reflection_timer__?.unref?.();
  };

  // First run after 5 minutes — даём серверу подняться.
  // P1-3 fix (H-MEM-6): .unref() so the timer doesn't keep the event loop alive.
  g.__lia_reflection_initial_timer__ = setTimeout(async () => {
    g.__lia_reflection_initial_timer__ = undefined;
    try {
      await runReflection();
    } catch (e) {
      logger.warn('memory', 'Initial reflection failed', {}, e);
    }
    scheduleNext();
  }, 5 * 60 * 1000);
  g.__lia_reflection_initial_timer__?.unref?.();

  logger.info('memory', `Reflection engine started (${Math.round(REFLECTION_INTERVAL_MS / 1000 / 60)}min interval, recursive setTimeout)`);
}

/**
 * Остановить reflection engine. Idempotent. HMR-safe.
 */
export function stopReflectionEngine(): void {
  g.__lia_reflection_running__ = false;
  if (g.__lia_reflection_timer__) {
    clearTimeout(g.__lia_reflection_timer__);
    delete g.__lia_reflection_timer__;
  }
  if (g.__lia_reflection_initial_timer__) {
    clearTimeout(g.__lia_reflection_initial_timer__);
    delete g.__lia_reflection_initial_timer__;
  }
  logger.info('memory', 'Reflection engine stopped');
}

/**
 * Один цикл reflection — консолидация unconsolidated emotional anchors.
 */
async function runReflection(): Promise<{
  groupsProcessed: number;
  anchorsConsolidated: number;
  summariesCreated: number;
}> {
  if (process.env.LIA_REFLECTION_ENGINE !== 'true') {
    return { groupsProcessed: 0, anchorsConsolidated: 0, summariesCreated: 0 };
  }

  logger.debug('memory', 'Running reflection cycle...');

  // 1. Загружаем все unconsolidated anchors
  const anchors = await db.emotionalMemory.findMany({
    where: { consolidated: false },
    orderBy: { ts: 'asc' },
    take: 100,  // обрабатываем пачками, не всё за раз
  });

  if (anchors.length < MIN_ANCHORS_TO_CONSOLIDATE) {
    logger.debug('memory', 'Reflection: not enough unconsolidated anchors', {
      count: anchors.length,
      min: MIN_ANCHORS_TO_CONSOLIDATE,
    });
    return { groupsProcessed: 0, anchorsConsolidated: 0, summariesCreated: 0 };
  }

  // 2. Группируем по эмоции (грубая группировка)
  const byEmotion = new Map<string, typeof anchors>();
  for (const anchor of anchors) {
    const group = byEmotion.get(anchor.emotion) ?? [];
    group.push(anchor);
    byEmotion.set(anchor.emotion, group);
  }

  let groupsProcessed = 0;
  let anchorsConsolidated = 0;
  let summariesCreated = 0;

  // 3. Для каждой эмоциональной группы — подгруппируем по семантической близости
  for (const [emotion, emotionAnchors] of byEmotion) {
    if (emotionAnchors.length < 3) continue;  // не консолидируем маленькие группы

    // Вычисляем embeddings если их нет
    const anchorEmbeddings: Array<{ anchor: typeof emotionAnchors[0]; embedding: Float32Array | null }> = [];
    for (const anchor of emotionAnchors) {
      if (anchor.embedding) {
        // Decode existing embedding from Bytes
        try {
          const buf = Buffer.from(anchor.embedding);
          const embedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          anchorEmbeddings.push({ anchor, embedding: new Float32Array(embedding) });
        } catch {
          anchorEmbeddings.push({ anchor, embedding: null });
        }
      } else {
        // Compute embedding on the fly
        try {
          const emb = await embed(anchor.context.slice(0, 500));
          anchorEmbeddings.push({ anchor, embedding: emb });
        } catch {
          anchorEmbeddings.push({ anchor, embedding: null });
        }
      }
    }

    // Группируем по cosine similarity
    const subGroups: Array<Array<typeof anchorEmbeddings[0]>> = [];
    const used = new Set<string>();

    for (let i = 0; i < anchorEmbeddings.length; i++) {
      if (used.has(anchorEmbeddings[i].anchor.id)) continue;
      const group: Array<typeof anchorEmbeddings[0]> = [anchorEmbeddings[i]];
      used.add(anchorEmbeddings[i].anchor.id);

      for (let j = i + 1; j < anchorEmbeddings.length; j++) {
        if (used.has(anchorEmbeddings[j].anchor.id)) continue;
        if (group.length >= MAX_ANCHORS_PER_GROUP) break;

        if (anchorEmbeddings[i].embedding && anchorEmbeddings[j].embedding) {
          const sim = cosineSimilarity(
            anchorEmbeddings[i].embedding!,
            anchorEmbeddings[j].embedding!,
          );
          if (sim >= SIMILARITY_THRESHOLD) {
            group.push(anchorEmbeddings[j]);
            used.add(anchorEmbeddings[j].anchor.id);
          }
        }
      }

      if (group.length >= 3) {
        subGroups.push(group);
      }
    }

    // 4. Для каждой подгруппы — LLM консолидация
    for (const group of subGroups) {
      try {
        const summary = await consolidateAnchorGroup(emotion, group);
        if (summary) {
          // Создаём новый consolidated anchor
          const summaryEmbedding = await embed(summary.context.slice(0, 500)).catch(() => null);

          let summaryEmbeddingBytes: Uint8Array<ArrayBuffer> | null = null;
          if (summaryEmbedding) {
            const ab = new ArrayBuffer(summaryEmbedding.byteLength);
            const view = new Uint8Array(ab);
            view.set(new Uint8Array(summaryEmbedding.buffer, summaryEmbedding.byteOffset, summaryEmbedding.byteLength));
            summaryEmbeddingBytes = view;
          }

          // Берем episodeId первого anchor в группе (для связи)
          const episodeId = group[0].anchor.episodeId;

          // P1-1 fix (C-MEM-1): create the summary anchor first so we have its ID,
          // then insert its embedding into vec_virtual. Previously the summary was
          // stored in Prisma EmotionalMemory but NEVER indexed in vec_virtual —
          // making it invisible to recallEmotionalAnchors. The entire reflection
          // engine's output was unreachable.
          const summaryRecord = await db.emotionalMemory.create({
            data: {
              episodeId,
              emotion,
              intensity: summary.intensity,
              trigger: summary.trigger,
              context: summary.context,
              emotionVectorJson: group[0].anchor.emotionVectorJson,
              embedding: summaryEmbeddingBytes,
              consolidated: true,
              sourceIds: JSON.stringify(group.map(g => g.anchor.id)),
            },
          });

          // Index the summary in vec_virtual so recallEmotionalAnchors can find it.
          if (summaryEmbedding) {
            try {
              const { insertEmotionalVectorIndex } = await import('@/lib/db-vec');
              insertEmotionalVectorIndex({
                vectorId: `emo:${summaryRecord.id}`,
                episodeId,
                embedding: summaryEmbedding,
              });
            } catch (vecErr) {
              // Non-fatal: summary is in Prisma but not vec index.
              // Recall won't find it, but at least Prisma is consistent.
              logger.warn('memory', 'Reflection: failed to index summary in vec_virtual', {}, vecErr);
            }
          }

          // P1-1 fix (C-MEM-1): delete old anchors' vec_virtual entries.
          // Previously old anchors were marked consolidated=true in Prisma but
          // their vec entries remained — recall returned stale duplicates
          // instead of the summary.
          try {
            const { deleteEmotionalVectorIndex } = await import('@/lib/db-vec');
            for (const g of group) {
              try {
                deleteEmotionalVectorIndex(`emo:${g.anchor.id}`);
              } catch {
                // Individual delete failure is non-fatal
              }
            }
          } catch (importErr) {
            logger.warn('memory', 'Reflection: failed to import deleteEmotionalVectorIndex', {}, importErr);
          }

          // Помечаем исходные anchors как consolidated
          await db.emotionalMemory.updateMany({
            where: { id: { in: group.map(g => g.anchor.id) } },
            data: { consolidated: true },
          });

          summariesCreated++;
          anchorsConsolidated += group.length;
          groupsProcessed++;

          logger.info('memory', 'Reflection: consolidated anchor group', {
            emotion,
            groupSize: group.length,
            summaryTrigger: summary.trigger.slice(0, 80),
          });
        }
      } catch (e) {
        logger.warn('memory', 'Reflection: failed to consolidate group', { emotion }, e);
      }
    }
  }

  logger.info('memory', 'Reflection cycle complete', {
    groupsProcessed,
    anchorsConsolidated,
    summariesCreated,
    totalUnconsolidated: anchors.length,
  });

  // Bound Prisma growth: drop old consolidated *source* rows (summaries kept).
  try {
    const { pruneEmotionalMemories } = await import('@/lib/memory/emotional-memory');
    await pruneEmotionalMemories({ keepDays: 90, maxDelete: 500 });
  } catch (e) {
    logger.warn('memory', 'Reflection: prune failed (non-fatal)', {}, e);
  }

  return { groupsProcessed, anchorsConsolidated, summariesCreated };
}

/**
 * LLM консолидация группы emotional anchors в один summary.
 *
 * Промпт: даём модели список якорей (trigger + context + intensity),
 * просим обобщить в один summary anchor.
 */
async function consolidateAnchorGroup(
  emotion: string,
  group: Array<{ anchor: { trigger: string; context: string; intensity: number; ts: Date }; embedding: Float32Array | null }>,
): Promise<{ trigger: string; context: string; intensity: number } | null> {
  const anchorsText = group.map((g, i) => {
    const date = g.anchor.ts.toISOString().slice(0, 10);
    return `${i + 1}. [${date}] (intensity: ${g.anchor.intensity.toFixed(2)}) ${g.anchor.trigger}\n   Context: ${g.anchor.context.slice(0, 200)}`;
  }).join('\n\n');

  const prompt = `Ты — Лия, ИИ-помощник. Проанализируй следующие эмоциональные воспоминания и создай одно обобщённое воспоминание.

Эмоция: ${emotion}
Количество воспоминаний: ${group.length}

Воспоминания:
${anchorsText}

Создай обобщённое воспоминание в JSON формате:
{
  "trigger": "короткое описание паттерна (до 200 символов)",
  "context": "развёрнутое описание паттерна — что общего, какие ситуации, как пользователь реагирует (до 1000 символов)",
  "intensity": "средняя интенсивность 0..1 (число)"
}

Правила:
- Обобщай паттерн, не перечисляй отдельные случаи
- Если воспоминания противоречивы — отметь это в context
- Trigger должен быть коротким и информативным
- Intensity — среднее арифметическое с учётом давности (недавние важнее)

JSON:`;

  try {
    const model = await getChatModel();
    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 500,
      temperature: 0.5,
      abortSignal: AbortSignal.timeout(30_000),
    });

    // P1-3 fix (H-MEM-2): use shared extractJson instead of greedy regex.
    const { extractJson } = await import('@/lib/infra/prompt-safety');
    const parsed = extractJson<{
      trigger: string;
      context: string;
      intensity: number;
    }>(result.text);
    if (!parsed) {
      logger.warn('memory', 'Reflection: LLM did not return JSON', {
        responsePreview: result.text.slice(0, 200),
      });
      return null;
    }

    // Sanity checks
    if (!parsed.trigger || !parsed.context) return null;
    const intensity = Math.max(0, Math.min(1, Number(parsed.intensity) || 0.5));

    return {
      trigger: parsed.trigger.slice(0, 200),
      context: parsed.context.slice(0, 1000),
      intensity,
    };
  } catch (e) {
    logger.warn('memory', 'Reflection: LLM consolidation failed', {}, e);
    return null;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
