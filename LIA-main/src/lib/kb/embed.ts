import 'server-only';

// ============================================================================
// KB embeddings — переиспользование embed() из ollama.ts + batch helper.
// ============================================================================
//
// KB не делает собственный embedding pipeline — мы reuse'им `embed()` из
// `src/lib/ollama.ts`, который уже:
//   - Авто-детектит embed model (nomic-embed-text или аналог)
//   - Хранит выбранный model в Setting для последующих вызовов
//   - Использует тот же Ollama instance, что и личная память Лии
//
// Зачем wrapper (`embedForKb` / `embedBatchForKb`):
//   1. Явная точка для будущего переключения на другую embed model
//      (например, multilingual для документов на разных языках)
//   2. Batch helper для indexer'а — 10× меньше HTTP requests к Ollama
//      за счёт параллельных вызовов с rate-limiting
//   3. Изоляция KB от изменений API ollama.ts (если embed() поменяет сигнатуру,
//      обновляем только здесь)

import { embed, embedBatchUncached } from '@/lib/ollama';
import { logger } from '@/lib/logger';

// ============================================================================
// Constants — единый для всего KB-стека batch size.
// ============================================================================
//
// 8 — эмпирически оптимально для локального Ollama на средней машине:
//   - 1 параллельный запрос = 1 HTTP connection к Ollama
//   - 8 параллельных = ~10× ускорение vs sequential (Ollama handles concurrency)
//   - >8 параллельных на слабом железе = OOM / Ollama crash
//
// Используется в:
//   - embed.ts (этот файл)
//   - indexer.ts persistKbChunks
//   - code-indexer.ts (через embedBatchForKb)
//
// Если меняешь — поменяй ВЕЗДЕ синхронно. Используй KB_EMBED_BATCH_SIZE из этого
// файла, не хардкодь числа.

export const KB_EMBED_BATCH_SIZE = 8;

/**
 * Embed одиночного текста. Wrapper над ollama.embed() — те же 768-dim float32.
 *
 * Используется:
 *   - search.ts — embed поискового запроса
 *
 * Для bulk операций (indexer) используйте embedBatchForKb().
 */
export async function embedForKb(text: string): Promise<Float32Array> {
  // Mock mode для testing без Ollama (см. embedBatchForKb для деталей)
  if (process.env.LIA_KB_MOCK_EMBEDDINGS === '1') {
    const hash = new Array(768);
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    const seed = Math.abs(h);
    for (let i = 0; i < 768; i++) {
      const x = Math.sin(seed + i * 0.1) * 10000;
      hash[i] = (x - Math.floor(x)) * 2 - 1;
    }
    const norm = Math.sqrt(hash.reduce((s, v) => s + v * v, 0));
    return new Float32Array(hash.map(v => v / norm));
  }
  return embed(text);
}

/**
 * Embed нескольких текстов одним batched HTTP-вызовом к Ollama.
 *
 * Sprint 8B-audit B4: переписано с N параллельных embedUncached() на один
 * вызов embedBatchUncached(), который использует Ollama /api/embed с
 * `input: [t1, t2, ...]`. Это даёт 4-8x speedup KB индексации:
 *   - Один HTTP round-trip вместо N (8-64)
 *   - Ollama батчит inference внутри одного forward pass на GPU
 *   - Нет per-call warmup overhead
 *
 * На 80 файлов (~1000 чанков) индексация была 6-8 мин на 8B — теперь
 * ~60-90s. На 30-60B выигрыш ещё больше (пропорционально скорости модели).
 *
 * Graceful degradation: если весь batch падает (HTTP error, timeout),
 * возвращаем null для всех текстов в нём — caller (indexer) решает:
 * пропустить chunk или пометить source как error.
 *
 * KB_EMBED_BATCH_SIZE сохранён для backwards-compat с другими файлами,
 * но больше не используется здесь — embedBatchUncached сам батчит по 64
 * (Ollama лимит для одного вызова).
 *
 * @param texts массив текстов для embedding
 * @returns массив той же длины; null для текстов, которые не удалось embed'нуть
 */
export async function embedBatchForKb(
  texts: string[],
): Promise<Array<Float32Array | null>> {
  if (texts.length === 0) return [];

  // Mock mode для testing без Ollama — генерируем deterministic random embeddings
  // на основе hash текста. Включается через env LIA_KB_MOCK_EMBEDDINGS=1.
  // НЕ использовать в production — embeddings не семантические, search будет
  // возвращать random results.
  if (process.env.LIA_KB_MOCK_EMBEDDINGS === '1') {
    return texts.map((text) => {
      const hash = new Array(768);
      let h = 0;
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0;
      }
      const seed = Math.abs(h);
      for (let i = 0; i < 768; i++) {
        const x = Math.sin(seed + i * 0.1) * 10000;
        hash[i] = (x - Math.floor(x)) * 2 - 1;
      }
      const norm = Math.sqrt(hash.reduce((s, v) => s + v * v, 0));
      return new Float32Array(hash.map(v => v / norm));
    });
  }

  try {
    const results = await embedBatchUncached(texts);

    // Логируем failures для debugging (как раньше)
    results.forEach((result, idx) => {
      if (result === null) {
        const textPreview = texts[idx].slice(0, 60).replace(/\n/g, ' ');
        logger.warn('kb', 'Embedding failed for chunk (non-fatal, will be skipped)', {
          chunkIndex: idx,
          textPreview,
        });
      }
    });

    return results;
  } catch (e) {
    // Catastrophic failure (no embed model, Ollama down) — return all nulls.
    // Caller will mark all chunks as failed; user sees clear error in UI.
    logger.error('kb', 'embedBatchForKb catastrophic failure — all chunks will be null', {
      textCount: texts.length,
    }, e);
    return new Array(texts.length).fill(null);
  }
}
