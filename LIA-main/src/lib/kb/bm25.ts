// ============================================================================
// BM25 — JavaScript implementation (FTS5 fallback path).
// ============================================================================
//
// Почему не FTS5: better-sqlite3 prebuilt binaries не включают FTS5 на Windows
// и большинстве Linux. Пересборка нетривиальна для конечного пользователя.
// Manual BM25 в JS — ~50 строк, работает везде, ~10ms на 1000 chunks.
//
// Алгоритм:
//   score(D, Q) = Σ_t∈Q IDF(t) * (f(t, D) * (k1 + 1)) / (f(t, D) + k1 * (1 - b + b * |D| / avgdl))
//
// Где:
//   - f(t, D) — частота термина t в документе D
//   - |D| — длина документа в токенах
//   - avgdl — средняя длина документа
//   - IDF(t) = log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
//   - N — общее число документов
//   - n(t) — число документов, содержащих t
//
// k1 = 1.5, b = 0.75 — стандартные эмпирические значения.
//
// Limitations:
//   - Для 100k+ chunks нужен inverted index (Phase 6+). Сейчас — linear scan.
//   - Tokenizer простой (lowercase + split on non-alphanumeric). Для сложных
//     языков (китайский, японский) нужен ICU tokenizer.

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { SearchResult, ChunkMetadata } from './types';
import { shouldUseInvertedIndex, getCorpusSize, bm25SearchInverted } from './inverted-index';

// ============================================================================
// Tokenizer
// ============================================================================

const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'what', 'which', 'who', 'when', 'where', 'why', 'how',
  'about', 'over', 'under', 'into', 'onto', 'out', 'up', 'down',
  // Russian
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'от', 'из', 'что', 'это',
  'как', 'не', 'но', 'да', 'или', 'ли', 'бы', 'же', 'только', 'даже',
  'если', 'то', 'так', 'там', 'тут', 'где', 'когда', 'почему', 'зачем',
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они',
  'быть', 'есть', 'нет', 'его', 'её', 'их', 'мой', 'твой', 'наш', 'ваш',
  'про', 'над', 'под', 'между', 'через', 'без', 'после', 'перед',
]);

// ============================================================================
// Snowball stemmer — Russian + English (~95% wordform coverage)
// ============================================================================
//
// Раньше использовали light stemmer (~80% coverage, ~30 строк JS).
// Сейчас — полноценный Snowball через пакет `snowball-stemmers` (pure JS,
// no native deps, ~95% coverage).
//
// Snowball — стандарт для BM25 stem'инга. Алгоритмы описаны на
// http://snowball.tartarus.org/ и портированы для ~25 языков.
//
// Принцип: strip суффиксов по правилам языка, восстанавливая "lemma"
// (не всегда точную, но достаточно для match wordforms).
//
// Стеммер применяется и к индексации, и к запросу — обе стороны
// нормализуются одинаково. Если меняешь стеммер — bump KB_TOKENIZER_VERSION
// (см. inverted-index.ts), auto-reindex переиндексирует все sources.

import snowballFactory from 'snowball-stemmers';

// Создаём стеммеры один раз при первом import — они не stateful, можно
// переиспользовать. Создание cheap, но нет смысла делать на каждый token.
const russianStemmer = snowballFactory.newStemmer('russian');
const englishStemmer = snowballFactory.newStemmer('english');

// Detect script по первому символу. Если кириллица — Russian stemmer,
// иначе — English (он работает и для Latin в других языках, давая
// reasonable approximation для французского/испанского/немецкого).
function snowballStem(word: string): string {
  if (word.length <= 2) return word;
  // \p{L} — any letter. Check first char for Cyrillic block.
  const firstChar = word[0];
  if (/[\u0400-\u04FF]/.test(firstChar)) {
    return russianStemmer.stem(word);
  }
  return englishStemmer.stem(word);
}

/**
 * Токенизация текста для BM25.
 *
 * Pipeline: lowercase → split на non-alphanumeric → filter length ≤ 1 →
 *           filter stopwords → Snowball stem (Russian + English).
 *
 * Работает для Latin и Cyrillic (Unicode-aware regex).
 *
 * Стеммер: Snowball (pure JS via `snowball-stemmers` package).
 * ~95% wordform coverage. Russian + English алгоритмы.
 *
 * ВАЖНО: стеммер применяется и к индексации (addToInvertedIndex), и к запросу
 * (bm25SearchInverted) — обе стороны нормализуются одинаково, поэтому
 * несоответствия нет. Если меняешь стеммер — bump KB_TOKENIZER_VERSION
 * в inverted-index.ts. Auto-reindex (см. server-startup.ts) переиндексирует
 * все sources с новым стеммером.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // \p{L} — любые буквы Unicode (включая кириллицу)
    // \p{N} — любые цифры
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => snowballStem(t));
}

// ============================================================================
// BM25 search
// ============================================================================

interface Bm25SearchParams {
  query: string;
  sourceTypes?: string[];
  sourceIds?: string[];
  limit: number;
}

/**
 * BM25 keyword search по Chunk table.
 *
 * Возвращает чанки отсортированные по убыванию BM25 score.
 *
 * Производительность:
 *   - 1000 chunks → ~10ms
 *   - 10000 chunks → ~100ms
 *   - 100000+ chunks → нужен inverted index (Phase 6+)
 *
 * Implementation note: загружаем ВСЕ chunks (с фильтром по source) в память,
 * считаем IDF по всему корпусу, потом скорим каждый chunk. Это O(N) на query,
 * что приемлемо для нашего объёма. Для больших KB нужен inverted index
 * (term → chunk_ids) с persisted в SQLite таблицу.
 *
 * Error handling: при любой ошибке возвращает [] — caller может graceful
 * деградировать до vector-only search.
 */
export async function bm25Search(params: Bm25SearchParams): Promise<SearchResult[]> {
  const queryTokens = tokenize(params.query);
  if (queryTokens.length === 0) return [];

  try {
    // Phase 7: для больших corpus (>5000 chunks) используем inverted index
    // вместо linear scan — O(Q * postings) вместо O(N * Q).
    const corpusSize = await getCorpusSize();
    if (shouldUseInvertedIndex(corpusSize)) {
      return await bm25SearchViaInvertedIndex(params);
    }

    // Linear scan (для небольших corpus — проще, без overhead)
    // Загружаем chunks с фильтром по source
    const where: { sourceId?: { in: string[] } } = {};
    if (params.sourceIds && params.sourceIds.length > 0) {
      where.sourceId = { in: params.sourceIds };
    }

    let chunks = await db.chunk.findMany({
      where,
      select: {
        id: true,
        content: true,
        sourceId: true,
        metadata: true,
        source: { select: { type: true, name: true } },
      },
    });

    // Filter by sourceType — делаем в JS т.к. source.type через relation
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      const allowed = new Set(params.sourceTypes);
      chunks = chunks.filter(c => allowed.has(c.source.type));
    }

    if (chunks.length === 0) return [];

    // ── Compute document frequencies (df) ──
    const N = chunks.length;
    const df = new Map<string, number>();
    for (const chunk of chunks) {
      const tokens = new Set(tokenize(chunk.content));
      for (const t of tokens) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }

    // ── Compute average document length ──
    let totalLength = 0;
    const docTokenCounts = new Map<string, number>();
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      docTokenCounts.set(chunk.id, tokens.length);
      totalLength += tokens.length;
    }
    const avgdl = totalLength / N || 1;

    // ── BM25 scoring ──
    const k1 = 1.5;
    const b = 0.75;

    const results: SearchResult[] = [];

    for (const chunk of chunks) {
      const docTokens = tokenize(chunk.content);
      const docLen = docTokens.length;
      const tf = new Map<string, number>();
      for (const t of docTokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }

      let score = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt);
        if (!f) continue;
        const d = df.get(qt) ?? 0;
        const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
        const numerator = f * (k1 + 1);
        const denominator = f + k1 * (1 - b + b * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        let metadata: ChunkMetadata;
        try {
          metadata = JSON.parse(chunk.metadata) as ChunkMetadata;
        } catch {
          metadata = { isComment: false } as ChunkMetadata;
        }
        results.push({
          id: chunk.id,
          sourceId: chunk.sourceId,
          content: chunk.content,
          metadata,
          score,
          matchType: 'bm25',
          sourceName: chunk.source.name,
          sourceType: chunk.source.type as 'document' | 'folder' | 'url',
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, params.limit);
  } catch (_e) {
    // Non-fatal: caller (search.ts) может деградировать до vector-only
    return [];
  }
}

// ============================================================================
// Inverted index BM25 — для 100k+ chunks (Phase 7)
// ============================================================================

/**
 * BM25 search через inverted index.
 *
 * Использует kb_inverted_index table (term → chunk_id, tf, doc_length).
 * O(Q * postings_per_term) вместо O(N * Q) linear scan.
 *
 * Возвращает SearchResults с content + metadata (JOIN с Prisma Chunk).
 */
async function bm25SearchViaInvertedIndex(params: Bm25SearchParams): Promise<SearchResult[]> {
  // Get hits from inverted index
  const hits = bm25SearchInverted({
    query: params.query,
    sourceIds: params.sourceIds,
    limit: params.limit * 2,  // over-fetch для sourceType filter
  });

  if (hits.length === 0) return [];

  // Load chunk content + metadata from Prisma
  const chunkIds = hits.map(h => h.chunk_id);
  const chunks = await db.chunk.findMany({
    where: { id: { in: chunkIds } },
    select: {
      id: true,
      content: true,
      sourceId: true,
      metadata: true,
      source: { select: { type: true, name: true } },
    },
  });

  // Optional sourceType filter
  let filteredChunks = chunks;
  if (params.sourceTypes && params.sourceTypes.length > 0) {
    const allowed = new Set(params.sourceTypes);
    filteredChunks = chunks.filter(c => allowed.has(c.source.type));
  }

  // Build results, preserving inverted index score
  const chunkMap = new Map(filteredChunks.map(c => [c.id, c]));
  const results: SearchResult[] = [];
  const ghostChunkIds: string[] = [];

  for (const hit of hits) {
    const chunk = chunkMap.get(hit.chunk_id);
    if (!chunk) {
      // Ghost posting — chunk удалён в Prisma, но term→chunk_id остался в
      // kb_inverted_index. Собираем для lazy cleanup.
      ghostChunkIds.push(hit.chunk_id);
      continue;
    }

    let metadata: ChunkMetadata;
    try {
      metadata = JSON.parse(chunk.metadata) as ChunkMetadata;
    } catch {
      metadata = { isComment: false } as ChunkMetadata;
    }

    results.push({
      id: chunk.id,
      sourceId: chunk.sourceId,
      content: chunk.content,
      metadata,
      score: hit.score,
      matchType: 'bm25',
      sourceName: chunk.source.name,
      sourceType: chunk.source.type as 'document' | 'folder' | 'url' | 'codebase',
    });
  }

  // Lazy cleanup: удаляем ghost postings fire-and-forget.
  if (ghostChunkIds.length > 0) {
    logger.warn('kb', `Detected ${ghostChunkIds.length} ghost BM25 posting(s) — scheduling lazy cleanup`, {
      sample: ghostChunkIds.slice(0, 3),
    });
    setImmediate(() => {
      for (const chunkId of ghostChunkIds) {
        try {
          import('./inverted-index').then(({ removeFromInvertedIndex }) => {
            removeFromInvertedIndex(chunkId);
          }).catch(() => null);
        } catch {
          // ignore
        }
      }
    });
  }

  return results.slice(0, params.limit);
}
