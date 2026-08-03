import type { SearchResult } from './types';
import { GROUNDING } from '@/lib/prompts/grounding';

const STOP_WORDS = new Set([
  'найди', 'информацию', 'информации', 'информация', 'должен', 'быть', 'там', 'папке', 'папка',
  'файл', 'файле', 'readme', 'база', 'документ', 'документе', 'источник',
  // Разговорный шум — не должен требоваться в тексте чанка
  'интересует', 'интересуют', 'волнует', 'расскажи', 'скажи', 'поясни', 'уточни',
  'давай', 'обсудим', 'обсудить', 'хочу', 'нужно', 'надо', 'можно', 'просто',
  'какой', 'какая', 'какие', 'какое', 'что', 'это', 'про', 'для', 'или', 'как',
]);

/** Cyrillic/Latin ALL-CAPS tokens (СМСВ, EGTS) — strong technical signals. */
const ACRONYM_RE = /(?<![\p{L}\p{N}])([\p{Lu}]{2,12})(?![\p{L}\p{N}])/gu;

// ============================================================================
// Memoization cache — эти функции вызываются 5+ раз на каждый chat message
// с одним и тем же input (buildKbSearchQuery, buildKbExcerptQuery,
// filterHitsForUserTerms, etc.). На длинных тредах это накапливается.
// Кэш по hash of input string. LRU с max 100 entries — достаточно для
// типичного диалога (10 messages × 5 calls = 50 уникальных inputs).
// ============================================================================

const MEMO_MAX = 100;
const _extractKbQueryKeywordsCache = new Map<string, string[]>();
const _extractContentIdentifiersCache = new Map<string, string[]>();
const _kbQueryTermsForMatchCache = new Map<string, string[]>();

function memoGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value !== undefined && cache.size > 1) {
    // Move to end (LRU) — delete + re-insert
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function memoSet<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MEMO_MAX) {
    // Delete oldest entry (first key in Map insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

/**
 * Извлечь значимые ключевые слова из запроса для post-filter KB hits.
 * Приоритет: UPPER_SNAKE identifiers, технические токены, длинные слова.
 *
 * Memoized — вызывается 5+ раз на каждый chat message с одним и тем же input.
 */
export function extractKbQueryKeywords(query: string): string[] {
  const cached = memoGet(_extractKbQueryKeywordsCache, query);
  if (cached) return cached;

  const keywords = new Set<string>();

  // Latin UPPER_SNAKE / ALLCAPS (legacy \b is ASCII-only — keep for EGTS_FOO)
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    keywords.add(m[0].toLowerCase());
  }

  // Cyrillic + Unicode ALL-CAPS acronyms (СМСВ, АДС)
  for (const m of query.matchAll(new RegExp(ACRONYM_RE.source, 'gu'))) {
    keywords.add(m[1].toLowerCase());
  }

  for (const m of query.matchAll(/`([^`]+)`/g)) {
    keywords.add(m[1].toLowerCase());
  }

  for (const id of extractContentIdentifiers(query)) {
    for (const part of id.split('_')) {
      if (part.length >= 3) keywords.add(part);
    }
  }

  for (const m of query.matchAll(/\b\d{2}[_./-]\d{2}[_./-]\d{2,4}\b/g)) {
    keywords.add(m[0].replace(/[./-]/g, '_').toLowerCase());
    keywords.add(m[0].toLowerCase());
  }

  for (const m of query.matchAll(/\b(\d{1,4})\b/g)) {
    keywords.add(m[1]);
  }

  // camelCase: eventDriver, getData
  for (const m of query.matchAll(/\b[a-z][a-zA-Z0-9]{2,}\b/g)) {
    if (/[A-Z]/.test(m[0])) keywords.add(m[0].toLowerCase());
  }

  const words = query.toLowerCase().split(/[\s,.;:!?()[\]{}«»"'`]+/);
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    // Короткие кириллические (смсв) — только через ACRONYM_RE (ALL-CAPS выше).
    // Иначе «меня»/«зовут» засоряют query и ложно включают KB lock.
    if (w.length >= 5) {
      keywords.add(w);
    } else if (w.length >= 3 && /^[a-z0-9]+$/i.test(w)) {
      keywords.add(w);
    }
  }

  const result = [...keywords];
  memoSet(_extractKbQueryKeywordsCache, query, result);
  return result;
}

/** Идентификаторы из тела документа (UPPER_SNAKE / ALLCAPS), не из имени файла. Memoized. */
export function extractContentIdentifiers(query: string): string[] {
  const cached = memoGet(_extractContentIdentifiersCache, query);
  if (cached) return cached;

  const ids = new Set<string>();
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    ids.add(m[0].toLowerCase());
  }
  for (const m of query.matchAll(new RegExp(ACRONYM_RE.source, 'gu'))) {
    ids.add(m[1].toLowerCase());
  }
  for (const m of query.matchAll(/`([^`]+)`/g)) {
    if (m[1].includes('_') || /^[\p{Lu}]{2,}$/u.test(m[1])) ids.add(m[1].toLowerCase());
  }

  const result = [...ids];
  memoSet(_extractContentIdentifiersCache, query, result);
  return result;
}

/** Термины из запроса для поиска фрагмента в документе. Memoized. */
export function kbQueryTermsForMatch(query: string): string[] {
  const cached = memoGet(_kbQueryTermsForMatchCache, query);
  if (cached) return cached;

  const terms = new Set<string>([
    ...extractKbQueryKeywords(query),
    ...extractContentIdentifiers(query),
  ]);

  for (const m of query.matchAll(/\b(\d{1,4})\b/g)) {
    terms.add(m[1]);
  }

  const words = query.toLowerCase().split(/[\s,.;:!?()[\]{}«»"'`]+/);
  for (const w of words) {
    if (w.length >= 3 && /^[a-z0-9]+$/i.test(w)) {
      terms.add(w);
    }
  }

  const result = [...terms];
  memoSet(_kbQueryTermsForMatchCache, query, result);
  return result;
}

/**
 * Фрагмент для промпта: центрировать на идентификаторе из запроса, не обрезать с начала.
 *
 * Совпавшие термины оборачиваются в <mark>...</mark> — markdown renderer
 * поддерживает HTML, в UI они будут подсвечены. Помогает модели и
 * пользователю быстро увидеть где именно совпадение.
 *
 * Highlighting strategy: только exact matches длинных терминов (>=5 chars),
 * не оборачиваем подстроки внутри identifier (EGTS_SR_ADAS_DATA целиком,
 * не EGTS, SR, ADAS, DATA по отдельности). Это предотвращает nested <mark>
 * теги и сохраняет читаемость identifier.
 *
 * Highlighting controlled by LIA_KB_HIGHLIGHT env var (default: true).
 */
export function formatKbHitForPrompt(
  content: string,
  query: string,
  maxChars = 2500,
): string {
  const allTerms = kbQueryTermsForMatch(query).sort((a, b) => b.length - a.length);
  const highlightEnabled = process.env.LIA_KB_HIGHLIGHT !== 'false';

  // Для highlighting: только термины >= 5 chars, отсортированы по длине
  // (longest first — чтобы EGTS_SR_ADAS_DATA обработался раньше EGTS).
  // Без longest-first получилось бы nested <mark>.
  const highlightTerms = highlightEnabled
    ? allTerms.filter(t => t.length >= 5).sort((a, b) => b.length - a.length)
    : [];

  const lower = content.toLowerCase();
  for (const term of allTerms) {
    const idx = lower.indexOf(term);
    if (idx < 0) continue;

    const start = Math.max(0, idx - Math.floor(maxChars * 0.12));
    const slice = content.slice(start, start + maxChars);
    const prefix = start > 0 ? '…' : '';
    const suffix = start + maxChars < content.length ? '…' : '';

    if (!highlightEnabled || highlightTerms.length === 0) {
      return prefix + slice + suffix;
    }

    return prefix + applyHighlight(slice, highlightTerms) + suffix;
  }

  if (!highlightEnabled || highlightTerms.length === 0) {
    return content.length > maxChars ? content.slice(0, maxChars) + '…' : content;
  }

  // No center term found — still highlight matches in truncated content
  const truncated = content.length > maxChars ? content.slice(0, maxChars) + '…' : content;
  return applyHighlight(truncated, highlightTerms);
}

/**
 * Apply <mark> highlighting для списка терминов в тексте.
 * Longest-first сортировка предотвращает nested <mark>.
 * Skip уже обёрнутых (внутри существующего <mark>...</mark>).
 */
function applyHighlight(text: string, terms: string[]): string {
  let result = text;
  for (const term of terms) {
    // Escape regex special chars
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match term НЕ внутри существующего <mark> (используем negative lookbehind/lookahead)
    // \b — word boundary, чтобы не подсвечивать 'data' внутри 'database'
    try {
      result = result.replace(
        new RegExp(`(?<!<mark>[^<]*)\\b(${escaped})\\b(?![^<]*</mark>)`, 'gi'),
        '<mark>$1</mark>',
      );
    } catch {
      // Если regex не поддерживает lookbehind (старые движки) — fallback на simple replace
      result = result.replace(
        new RegExp(`\\b(${escaped})\\b`, 'gi'),
        '<mark>$1</mark>',
      );
    }
  }
  return result;
}

export function kbHitsContainIdentifier(query: string, hits: Array<{ content: string }>): boolean {
  const ids = extractContentIdentifiers(query);
  if (ids.length === 0) return false;
  const blob = hits.map(h => h.content.toLowerCase()).join('\n');
  return ids.some(id => blob.includes(id));
}

/** KB нашла ответ — можно блокировать tools и якорить модель на фрагменте. */
export function kbHitsReadyForAnswer(
  userMessage: string,
  hits: Array<{ content: string; citation?: string; sourceName?: string; metadata?: unknown; matchType?: string }>,
  snippetMatchesUserQuery: (msg: string, snippet: string, threadIds?: string[]) => boolean,
  threadIdentifiers: string[] = [],
  excerptQuery?: string,
): boolean {
  if (hits.length === 0) return false;

  const focusQuery = excerptQuery ?? userMessage;
  const snippet = formatKbHitForPrompt(hits[0].content, focusQuery);

  if (snippetMatchesUserQuery(userMessage, snippet, threadIdentifiers)) return true;

  if (extractContentIdentifiers(userMessage).length > 0) {
    return kbHitsContainIdentifier(userMessage, [{ content: snippet }]);
  }

  return false;
}

function hitMatchesKeywords(hit: SearchResult, keywords: string[]): boolean {
  const meta = hit.metadata as { relativePath?: string; heading?: string };
  const blob = [
    hit.content,
    hit.citation ?? '',
    hit.sourceName ?? '',
    meta.relativePath ?? '',
    meta.heading ?? '',
  ].join(' ').toLowerCase();

  return keywords.some(kw => blob.includes(kw));
}

/**
 * Если keyword-фильтр обнулил hits, а семантический поиск что-то нашёл —
 * вернуть top raw (не говорить «не нашла»). Caller не должен answer-lock.
 */
export function withSoftKbHitFallback(
  filtered: SearchResult[],
  raw: SearchResult[],
  limit = 3,
): { hits: SearchResult[]; usedSoftFallback: boolean } {
  if (filtered.length > 0) return { hits: filtered, usedSoftFallback: false };
  if (raw.length === 0) return { hits: [], usedSoftFallback: false };
  const sorted = [...raw].sort((a, b) => b.score - a.score);
  return { hits: sorted.slice(0, limit), usedSoftFallback: true };
}

/**
 * Если в запросе есть конкретные идентификаторы — оставляем только релевантные chunks.
 * Если ни один не совпал — возвращаем пустой список (не подмешиваем README и т.п.).
 */
export function filterKbHitsForQuery(
  hits: SearchResult[],
  query: string,
): { hits: SearchResult[]; strictFilterApplied: boolean } {
  const keywords = extractKbQueryKeywords(query).filter(kw => !STOP_WORDS.has(kw));

  const hasStrongIdentifiers = keywords.some(kw =>
    kw.includes('_')
    || /^[a-z0-9]*\d{2}_\d{2}/.test(kw)
    // Short Cyrillic acronyms (смсв) — treat as strong so we don't mix in unrelated README
    || (kw.length >= 3 && kw.length <= 6 && /^[\u0400-\u04ff]+$/i.test(kw)),
  );

  if (!hasStrongIdentifiers && keywords.length < 2) {
    return { hits, strictFilterApplied: false };
  }

  const filtered = hits.filter(h => hitMatchesKeywords(h, keywords));
  return { hits: filtered, strictFilterApplied: true };
}

export function buildKbNotFoundContext(params: {
  query: string;
  strictFilterApplied: boolean;
  readySources: Array<{ name: string; type: string; chunkCount: number; status: string }>;
}): string {
  const readySources = params.readySources.filter(s => s.status === 'ready');
  const sourceList = readySources.length > 0
    ? readySources.map(s => `- ${s.name} (${s.type}, ${s.chunkCount} chunks)`).join('\n')
    : '(нет готовых источников)';

  const extraHints: string[] = [];
  if (params.readySources.every(s => s.type !== 'folder')) {
    extraHints.push(
      'Папка на диске ещё не добавлена в KB. Настройки → База знаний → «Добавить папку».',
    );
  }

  // ── Suggestions: если в available sources есть похожие по имени/типу ──
  // Помогает модели предложить альтернативу: «не нашла EGTS, но есть
  // документация по CAN — может это?»
  const queryTerms = extractKbQueryKeywords(params.query).map(t => t.toLowerCase());
  const suggestedSources: string[] = [];
  for (const source of readySources.slice(0, 8)) {
    const sourceNameLower = source.name.toLowerCase();
    // Check if any query term appears in source name
    if (queryTerms.some(term => sourceNameLower.includes(term) || term.includes(sourceNameLower.split(/[\s._-]/)[0]))) {
      suggestedSources.push(`- ${source.name} (${source.type})`);
    }
  }

  const suggestionsBlock = suggestedSources.length > 0
    ? [
        '',
        'Возможно релевантные источники (имя совпадает с терминами из запроса):',
        ...suggestedSources,
        'Если уместно — предложи пользователю проверить эти источники.',
      ].join('\n')
    : '';

  return [
    `Результаты поиска по базе знаний: по запросу «${params.query.slice(0, 120)}» ничего релевантного не найдено.`,
    params.strictFilterApplied
      ? '(Семантический поиск вернул другие документы, но они не содержат ключевых слов из запроса — они отброшены.)'
      : '',
    '',
    'Доступные источники в KB:',
    sourceList,
    ...extraHints,
    suggestionsBlock,
    '',
    'Правила ответа:',
    '- Честно скажи: «В базе знаний не нашла информации по этому запросу».',
    '- Перечисли доступные источники если уместно.',
    '- Предложи уточнить запрос или добавить нужный документ.',
    `- ${GROUNDING.noFabricateDocContent}`,
  ].filter(Boolean).join('\n');
}
