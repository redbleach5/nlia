/**
 * BM25 search — JavaScript implementation.
 *
 * Ported (simplified) from v2 src/lib/kb/bm25.ts.
 * Per docs/ARCHITECTURE.md § 7.3 — FTS5 primary, JS inverted index fallback.
 * M4: JS implementation only (FTS5 not available in all better-sqlite3 builds).
 *
 * Algorithm:
 *   score(D, Q) = Σ_t∈Q IDF(t) * (f(t, D) * (k1 + 1)) / (f(t, D) + k1 * (1 - b + b * |D| / avgdl))
 *
 * k1 = 1.5, b = 0.75 — standard empirical values.
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { chunks, resources } from "../db/schema.js";
import type { SearchResult, ChunkMetadata } from "@lia/shared";

// ─── Stopwords (English + Russian) ────────────────────────────────────
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "should", "could", "may", "might", "must", "can", "this", "that",
  "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "what", "which", "who", "when", "where", "why", "how",
  // Russian
  "и", "в", "во", "на", "с", "со", "по", "для", "от", "из", "что", "это",
  "как", "не", "но", "да", "или", "ли", "бы", "же", "только", "даже",
  "если", "то", "так", "там", "тут", "где", "когда", "почему", "зачем",
  "я", "ты", "он", "она", "оно", "мы", "вы", "они",
  "быть", "есть", "нет", "его", "её", "их", "мой", "твой", "наш", "ваш",
]);

// ─── Tokenizer + simple stemmer ───────────────────────────────────────
/**
 * Tokenize + stem a text. Simple suffix-stripping stemmer for Russian + English.
 * Not as accurate as Snowball (~80% vs ~95% coverage) but no native deps.
 */
function tokenizeAndStem(text: string): string[] {
  const tokens: string[] = [];
  // Split on non-alphanumeric (works for Cyrillic + Latin)
  const raw = text.toLowerCase().split(/[^a-zа-яё0-9_]+/i).filter(Boolean);
  for (const tok of raw) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    tokens.push(stem(tok));
  }
  return tokens;
}

/**
 * Simple stemmer: strip common Russian + English suffixes.
 */
function stem(word: string): string {
  // Russian suffixes (longest first)
  const ruSuffixes = [
    "ости", "ость", "ования", "ование", "енного", "енная", "ение", "ений",
    "иях", "иям", "иями", "ями", "ами", "ого", "ому", "ыми", "ими",
    "ает", "ают", "ил", "ила", "или", "ено", "ены", "ет", "ут", "ют",
    "ал", "ала", "али", "ах", "ям", "ях", "ей", "ею", "ию", "ия",
    "ой", "ою", "ы", "а", "я", "о", "е", "у", "и", "ю",
  ];
  // English suffixes
  const enSuffixes = [
    "ational", "tional", "ization", "ization", "fulness", "ousness",
    "iveness", "ement", "ation", "ition", "able", "ible", "ment",
    "ness", "ing", "ed", "ies", "ied", "ers", "est", "ly", "es", "er", "s",
  ];

  // Detect script
  const isCyrillic = /[а-яё]/i.test(word);
  const suffixes = isCyrillic ? ruSuffixes : enSuffixes;
  const minStemLen = isCyrillic ? 3 : 2;

  for (const suffix of suffixes) {
    if (word.length - suffix.length >= minStemLen && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

// ─── BM25 scoring ─────────────────────────────────────────────────────
const K1 = 1.5;
const B = 0.75;

interface BM25Doc {
  chunkId: string;
  resourceId: string;
  content: string;
  metadata: ChunkMetadata;
  tokens: string[];
  termFreqs: Map<string, number>;
}

let corpusCache: BM25Doc[] | null = null;

/**
 * Load all chunks from DB and build the BM25 corpus.
 * Cached in-memory; invalidated on reindex.
 */
function loadCorpus(resourceIds?: string[]): BM25Doc[] {
  if (corpusCache && !resourceIds) return corpusCache;

  const sqlite = getDb();
  const db = drizzle(sqlite);

  const chunkRows = db
    .select({
      id: chunks.id,
      resourceId: chunks.resourceId,
      content: chunks.content,
      metadata: chunks.metadata,
    })
    .from(chunks)
    .all();

  const docs: BM25Doc[] = chunkRows.map((row) => {
    const tokens = tokenizeAndStem(row.content);
    const termFreqs = new Map<string, number>();
    for (const tok of tokens) {
      termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + 1);
    }
    return {
      chunkId: row.id,
      resourceId: row.resourceId,
      content: row.content,
      metadata: JSON.parse(row.metadata) as ChunkMetadata,
      tokens,
      termFreqs,
    };
  });

  if (!resourceIds) {
    corpusCache = docs;
  }

  return docs;
}

/** Invalidate the corpus cache (called after indexing). */
export function invalidateBm25Cache(): void {
  corpusCache = null;
}

/**
 * Search chunks using BM25.
 *
 * @param query       search query
 * @param resourceIds scope to specific resources (undefined = all)
 * @param limit       max results
 * @returns ranked SearchResult[]
 */
export function bm25Search(
  query: string,
  opts: { resourceIds?: string[]; limit?: number } = {},
): SearchResult[] {
  const limit = opts.limit ?? 20;
  const queryTokens = tokenizeAndStem(query);
  if (queryTokens.length === 0) return [];

  const allDocs = loadCorpus();
  const docs = opts.resourceIds
    ? allDocs.filter((d) => opts.resourceIds!.includes(d.resourceId))
    : allDocs;

  if (docs.length === 0) return [];

  // Compute IDF for each query token
  const localAvgDl = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
  const N = docs.length;

  const idfMap = new Map<string, number>();
  for (const tok of queryTokens) {
    const docFreq = docs.filter((d) => d.termFreqs.has(tok)).length;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
    idfMap.set(tok, idf);
  }

  // Score each doc
  const scored: Array<{ doc: BM25Doc; score: number }> = [];
  for (const doc of docs) {
    let score = 0;
    const dl = doc.tokens.length || 1;
    for (const tok of queryTokens) {
      const tf = doc.termFreqs.get(tok) ?? 0;
      if (tf === 0) continue;
      const idf = idfMap.get(tok) ?? 0;
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + B * (dl / localAvgDl));
      score += idf * (numerator / denominator);
    }
    if (score > 0) {
      scored.push({ doc, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Load resource names for results
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const resourceIdSet = new Set(scored.map((s) => s.doc.resourceId));
  const resourceRows = db
    .select({ id: resources.id, name: resources.name, kind: resources.kind })
    .from(resources)
    .all()
    .filter((r) => resourceIdSet.has(r.id));
  const resourceMap = new Map(resourceRows.map((r) => [r.id, r]));

  return scored.slice(0, limit).map(({ doc, score }) => ({
    chunkId: doc.chunkId,
    resourceId: doc.resourceId,
    content: doc.content,
    metadata: doc.metadata,
    score,
    matchType: "bm25" as const,
    resourceName: resourceMap.get(doc.resourceId)?.name ?? "",
    resourceKind: resourceMap.get(doc.resourceId)?.kind ?? "",
  }));
}
