import {
  extractContentIdentifiers,
  extractKbQueryKeywords,
  kbQueryTermsForMatch,
} from './kb-query-filter';
import type { SearchResult } from './types';

interface ChatTurn {
  role: string;
  content: string;
}

/** Короткие уточнения без явного «найди в базе». */
const FOLLOW_UP_STEMS = [
  'подробнее', 'расскажи', 'уточни', 'поясни', 'а что', 'а как', 'а там',
  'туда', 'там', 'в этом', 'в нём', 'в ней', 'это', 'эти',
  'входит', 'входят', 'содержит', 'есть ли', 'имеется', 'какие',
];

const STRUCTURAL_STEMS = [
  'подзапис', 'таблиц', 'раздел', 'секци', 'пункт', 'глава', 'статья', 'приложен',
];

/** Слова уточнения — не считаются «конкретным термином» для lock/not-found. */
const CONVERSATIONAL_TERMS = new Set([
  'вся', 'всю', 'всей', 'информация', 'информации', 'информацию',
  'это', 'есть', 'там', 'туда', 'здесь', 'какой', 'какая', 'какие', 'какое',
  'подробнее', 'расскажи', 'уточни', 'поясни', 'имеется', 'содержит',
  'информацию', 'найди', 'базе', 'знаний',
  'интересует', 'интересуют', 'волнует', 'скажи', 'давай', 'обсудим', 'обсудить',
  'хочу', 'нужно', 'надо', 'можно', 'просто', 'сейчас', 'пожалуйста',
  // Личные/разговорные — иначе «меня»/«зовут» ложно lock'аят KB
  'меня', 'мне', 'мной', 'тебя', 'тебе', 'тобой', 'вас', 'вам', 'вами',
  'зовут', 'зови', 'помнишь', 'помни', 'знаешь', 'грубо', 'строго',
  'привет', 'пока', 'спасибо', 'пожалуйста', 'хорошо', 'ладно', 'понял', 'поняла',
]);

/** Уточнения без обязательного deixis (можно в KB-треде без «там/это»). */
const CLARIFY_STEMS = [
  'подробнее', 'расскажи', 'уточни', 'поясни',
  'входит', 'входят', 'содержит', 'есть ли', 'имеется', 'какие',
];

/** True if term is a technical acronym / identifier worth requiring in a chunk. */
export function isStrongKbTerm(term: string): boolean {
  const t = term.toLowerCase();
  if (CONVERSATIONAL_TERMS.has(t)) return false;
  if (t.includes('_')) return true;
  if (/^[a-z]+[A-Z]/.test(term)) return true; // camelCase original
  // Short Cyrillic: only ALL-CAPS acronyms survive extractKbQueryKeywords (СМСВ → смсв)
  if (t.length >= 2 && t.length <= 6 && /^[\u0400-\u04ff]+$/i.test(t)) return true;
  // Latin tech tokens (egts, movon, eventdriver) — not conversational Russian prose
  if (t.length >= 4 && /^[a-z][a-z0-9]*$/i.test(t)) return true;
  return false;
}

function hasDeixisOrStructure(message: string): boolean {
  const lower = message.toLowerCase();
  if (STRUCTURAL_STEMS.some(s => lower.includes(s))) return true;
  return /\b(эт[аоуеи]|там|туда|здесь|такой|такая|такие|такое|в этом|в нём|в ней)\b/i.test(message);
}

function isFollowUpMessage(message: string): boolean {
  const lower = message.toLowerCase();
  if (message.length >= 100) return false;
  // «подробнее» / «есть ли» — follow-up даже без deixis
  if (CLARIFY_STEMS.some(s => lower.includes(s))) return true;
  // «а что» / «а как» без deixis ловят smalltalk («А что так грубо?»)
  if (FOLLOW_UP_STEMS.some(s => lower.includes(s)) && hasDeixisOrStructure(message)) return true;
  return hasDeixisOrStructure(message) && message.length < 80;
}

/** Документные расширения, которые можно брать из цитат companion (не листинги папок). */
const DOC_SOURCE_EXT = 'docx|pdf|md|doc';
/** Tech backtick from companion: UPPER_SNAKE / ALL-CAPS, не `1.jpg` / `conf.zip`. */
const COMPANION_TECH_BACKTICK = /^[A-Z][A-Z0-9_]{2,}$|^[\p{Lu}]{2,12}$/u;

/**
 * Контекст KB-треда: идентификаторы из сообщений пользователя + подсказки источников из цитат.
 * Не парсим имена файлов/ключевые слова из листингов companion — они засоряют поиск и lock.
 */
export function extractThreadKbContext(recentTurns: ChatTurn[]): {
  identifiers: string[];
  sourceHints: string[];
} {
  const identifiers = new Set<string>();
  const sourceHints = new Set<string>();

  for (const turn of recentTurns.slice(-10)) {
    const fromUser = turn.role === 'user';

    if (fromUser) {
      for (const id of extractContentIdentifiers(turn.content)) {
        identifiers.add(id);
      }
      for (const kw of extractKbQueryKeywords(turn.content)) {
        if (kw.includes('_')) identifiers.add(kw);
      }
      // .txt только от пользователя — в ответах модели это часто листинг папки
      for (const m of turn.content.matchAll(/\b[\w\u0400-\u04FF.-]+\.txt\b/gi)) {
        sourceHints.add(m[0]);
      }
      for (const m of turn.content.matchAll(/`([^`]+)`/g)) {
        const token = m[1].toLowerCase();
        if (token.includes('_') || token.includes('.')) identifiers.add(token);
      }
    } else {
      // Companion: только tech-идентификаторы в backticks, не файлы/картинки
      for (const m of turn.content.matchAll(/`([^`]+)`/g)) {
        if (COMPANION_TECH_BACKTICK.test(m[1])) {
          identifiers.add(m[1].toLowerCase());
        }
      }
    }

    // Цитаты документов (docx/pdf/…) — из любого хода; без .txt
    for (const m of turn.content.matchAll(
      new RegExp(`\\b[\\w\\u0400-\\u04FF.-]+\\.(?:${DOC_SOURCE_EXT})\\b`, 'gi'),
    )) {
      sourceHints.add(m[0]);
    }
    for (const m of turn.content.matchAll(/\[[^\]]+>\s*([^\]]+)\]/g)) {
      sourceHints.add(m[1].trim());
    }
  }

  return { identifiers: [...identifiers], sourceHints: [...sourceHints] };
}

function extractThreadKbSignals(
  recentTurns: ChatTurn[],
  isKbQuestion: (msg: string) => boolean,
): {
  identifiers: string[];
  hasKbDiscussion: boolean;
} {
  const { identifiers, sourceHints } = extractThreadKbContext(recentTurns);
  const recent = recentTurns.slice(-10);

  const hasKbDiscussion =
    identifiers.length > 0
    || sourceHints.length > 0
    || recent.some(t => t.role === 'user' && isKbQuestion(t.content));

  return { identifiers, hasKbDiscussion };
}

/**
 * Конкретные термины из текущего сообщения (не из треда).
 * Разговорные глаголы («интересует») отбрасываются — они не встречаются в документах.
 */
export function extractUserSpecificTerms(message: string): string[] {
  return kbQueryTermsForMatch(message).filter(t => {
    if (/^\d{1,2}_\d{2}_\d{4}$/.test(t)) return false;
    return isStrongKbTerm(t);
  });
}

function isGenericKbFollowUp(message: string): boolean {
  return isFollowUpMessage(message) && extractUserSpecificTerms(message).length === 0;
}

/**
 * Нужен ли proactive KB search: явный KB-вопрос или уточнение в треде с KB-контекстом.
 *
 * ALL-CAPS / identifiers alone do NOT trigger search unless the thread is already
 * about KB or the message is an explicit KB question (latency false-positive fix).
 */
export function shouldPreSearchKbForChat(
  message: string,
  recentTurns: ChatTurn[],
  isKbQuestion: (msg: string) => boolean,
): boolean {
  if (isKbQuestion(message)) return true;

  const { hasKbDiscussion } = extractThreadKbSignals(recentTurns, isKbQuestion);

  // Identifiers (UPPER_SNAKE / Cyrillic ALL-CAPS) only when already in a KB thread.
  if (extractContentIdentifiers(message).length > 0 && hasKbDiscussion) return true;

  if (!hasKbDiscussion) return false;

  if (extractUserSpecificTerms(message).length > 0) return true;

  if (isFollowUpMessage(message)) return true;

  const lower = message.toLowerCase();
  if (/\b\d{1,4}\b/.test(message) && STRUCTURAL_STEMS.some(s => lower.includes(s))) {
    return true;
  }

  return false;
}

/**
 * Поисковый запрос: текущее сообщение + идентификаторы/файлы из треда (без paraphrase модели).
 */
export function buildKbSearchQuery(message: string, recentTurns: ChatTurn[]): string {
  const { identifiers, sourceHints } = extractThreadKbContext(recentTurns);
  const parts = [message.trim(), ...identifiers, ...sourceHints];

  for (const kw of extractKbQueryKeywords(message)) {
    if (kw.length >= 3) parts.push(kw);
  }

  return [...new Set(parts.filter(Boolean))].join(' ');
}

/** Запрос для центрирования excerpt: конкретные термины пользователя или якорь из треда. */
export function buildKbExcerptQuery(
  message: string,
  threadIdentifiers: string[],
): string {
  const specific = extractUserSpecificTerms(message);
  if (specific.length > 0) return message;
  if (threadIdentifiers.length > 0) {
    return [message, ...threadIdentifiers].join(' ');
  }
  return message;
}

/**
 * Фрагмент отвечает на вопрос пользователя (не на обогащённый поисковый запрос).
 */
export function kbSnippetMatchesUserQuery(
  userMessage: string,
  snippet: string,
  threadIdentifiers: string[] = [],
): boolean {
  const lower = snippet.toLowerCase();
  const specific = extractUserSpecificTerms(userMessage);

  if (specific.length > 0) {
    return specific.some(t => lower.includes(t.toLowerCase()));
  }

  const userIds = extractContentIdentifiers(userMessage);
  if (userIds.some(id => lower.includes(id))) return true;

  if (isGenericKbFollowUp(userMessage) && threadIdentifiers.length > 0) {
    return threadIdentifiers.some(id => lower.includes(id));
  }

  const qLower = userMessage.toLowerCase();
  const numericTerms = [...userMessage.matchAll(/\b(\d{1,4})\b/g)].map(m => m[1]);
  const hasStructuralRef = STRUCTURAL_STEMS.some(s => qLower.includes(s));
  if (hasStructuralRef && numericTerms.length > 0) {
    const snippetStructural = STRUCTURAL_STEMS.some(s => lower.includes(s));
    if (snippetStructural && numericTerms.some(n => lower.includes(n))) return true;
    if (snippetStructural && specific.length > 0) {
      return specific.some(t => lower.includes(t.toLowerCase()));
    }
  }

  return false;
}

/** Поднять hits из источников, уже обсуждавшихся в треде. */
export function prioritizeHitsByThreadSource(
  hits: SearchResult[],
  sourceHints: string[],
): SearchResult[] {
  if (sourceHints.length === 0) return hits;

  return [...hits].sort((a, b) => {
    const scoreA = threadSourceBonus(a, sourceHints);
    const scoreB = threadSourceBonus(b, sourceHints);
    return (b.score + scoreB) - (a.score + scoreA);
  });
}

function threadSourceBonus(
  hit: SearchResult,
  sourceHints: string[],
): number {
  const meta = hit.metadata as { relativePath?: string } | undefined;
  const blob = [
    hit.citation ?? '',
    hit.sourceName ?? '',
    meta?.relativePath ?? '',
  ].join(' ').toLowerCase();

  let bonus = 0;
  for (const hint of sourceHints) {
    const h = hint.toLowerCase();
    const base = h.split(/[/\\]/).pop() ?? h;
    if (blob.includes(h) || blob.includes(base)) bonus += 15;
  }
  return bonus;
}

/** Оставить только hits, где есть конкретный термин из вопроса пользователя. */
export function filterHitsForUserTerms(
  hits: SearchResult[],
  userMessage: string,
): SearchResult[] {
  const terms = extractUserSpecificTerms(userMessage);
  if (terms.length === 0) return hits;

  const matched = hits.filter(h => {
    const lower = h.content.toLowerCase();
    return terms.some(t => lower.includes(t.toLowerCase()));
  });

  // Soft: if strong terms failed to match, keep original hits for soft-fallback upstream.
  // Do not zero out on conversational-only queries (already empty terms → returned above).
  if (matched.length === 0 && terms.some(isStrongKbTerm)) {
    return matched;
  }
  if (matched.length === 0) return hits;

  return matched;
}
