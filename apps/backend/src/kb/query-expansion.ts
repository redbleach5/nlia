/**
 * Query expansion — multi-query + HyDE.
 * Per docs/ARCHITECTURE.md § 7.3.
 *
 * Multi-query: LLM generates 3 reformulations of the query, search runs
 * on all, RRF fusion combines results.
 *
 * HyDE (Hypothetical Document Embedding): LLM generates a hypothetical
 * answer, embeds it, uses as query. Works well for research queries
 * where the query doesn't match document phrasing.
 */

import { generateText } from "ai";
import { getChatModel } from "../llm/ollama.js";
import { extractJson } from "../infra/prompt-safety.js";
import { logger } from "../util/logger.js";

const EXPANSION_TIMEOUT_MS = 15_000;

const MULTI_QUERY_PROMPT = `Переформулируй поисковый запрос 3 разными способами для лучшего семантического поиска.

Правила:
1. Сохраняй смысл, меняй формулировку.
2. Разные стили: прямой, описательный, вопросительный.
3. JSON: {"queries": ["...", "...", "..."]}

Запрос: {QUERY}

Переформулировки (JSON):`;

const HYDE_PROMPT = `Представь, что ты уже нашла ответ на этот запрос. Напиши гипотетический ответ (2-3 предложения), который будет использован для семантического поиска.

Запрос: {QUERY}

Гипотетический ответ:`;

/**
 * Generate 3 query reformulations for multi-query expansion.
 * Returns [original, ...reformulations].
 */
export async function expandMultiQuery(query: string): Promise<string[]> {
  try {
    const model = await getChatModel();
    const prompt = MULTI_QUERY_PROMPT.replace("{QUERY}", query.slice(0, 500));

    const result = await generateText({
      model,
      system: "Ты — модуль расширения поисковых запросов. Возвращай только валидный JSON.",
      prompt,
      temperature: 0.5,
      abortSignal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS),
    });

    const parsed = extractJson<{ queries?: string[] }>(result.text);
    if (!parsed?.queries || !Array.isArray(parsed.queries)) {
      return [query];
    }

    const reformulations = parsed.queries
      .filter((q) => typeof q === "string" && q.trim().length > 0)
      .slice(0, 3);

    return [query, ...reformulations];
  } catch (e) {
    logger.warn({ err: e }, "multi-query expansion failed, using original query");
    return [query];
  }
}

/**
 * Generate a hypothetical document for HyDE.
 * Returns the hypothetical answer text (to be embedded as query).
 */
export async function generateHydeDocument(query: string): Promise<string | null> {
  try {
    const model = await getChatModel();
    const prompt = HYDE_PROMPT.replace("{QUERY}", query.slice(0, 500));

    const result = await generateText({
      model,
      prompt,
      temperature: 0.7,
      abortSignal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS),
    });

    const hydeText = result.text.trim();
    if (!hydeText || hydeText.length < 10) return null;

    logger.debug({ query: query.slice(0, 60), hydePreview: hydeText.slice(0, 60) }, "HyDE document generated");
    return hydeText;
  } catch (e) {
    logger.warn({ err: e }, "HyDE generation failed");
    return null;
  }
}

/**
 * Build the full query list for hybrid search with optional multi-query + HyDE.
 *
 * @param query    original query
 * @param opts     { multiQuery, hyde }
 * @returns array of queries to search (original always first)
 */
export async function buildExpandedQueries(
  query: string,
  opts: { multiQuery?: boolean; hyde?: boolean },
): Promise<string[]> {
  const queries = [query];

  if (opts.multiQuery) {
    const expanded = await expandMultiQuery(query);
    // Add only the reformulations (original already in array)
    for (const q of expanded.slice(1)) {
      queries.push(q);
    }
  }

  if (opts.hyde) {
    const hydeDoc = await generateHydeDocument(query);
    if (hydeDoc) {
      queries.push(hydeDoc);
    }
  }

  return queries;
}
