/**
 * Web search tool — real implementation (replaces M5 stub).
 * Per docs/ARCHITECTURE.md § 8.2 (category D: Web tools).
 *
 * Uses DuckDuckGo HTML scraping (no API key required).
 * M5.5 alternative: use SearXNG instance or Brave Search API.
 */

import { safeFetch } from "../../infra/ssrf.js";
import { logger } from "../../util/logger.js";

const MAX_RESULTS = 10;
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string): Promise<{
  results: WebSearchResult[];
  total: number;
}> {
  try {
    const res = await safeFetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Lia/3.0 (local AI companion)",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo returned ${res.status}`);
    }

    const html = await res.text();
    const results = parseDdgHtml(html);

    logger.info({ query: query.slice(0, 60), resultCount: results.length }, "web search completed");
    return { results: results.slice(0, MAX_RESULTS), total: results.length };
  } catch (e) {
    logger.warn({ err: e, query: query.slice(0, 60) }, "web search failed");
    return { results: [], total: 0 };
  }
}

/**
 * Parse DuckDuckGo HTML results.
 * Simple regex-based extraction (DDG HTML is predictable).
 */
function parseDdgHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // DDG HTML format: <a class="result__a" href="...">Title</a>
  // + <a class="result__snippet">Snippet</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1]!;
    const title = stripHtml(match[2]!).trim();
    if (title && url) {
      links.push({ url: decodeDdgUrl(url), title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]!).trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? "",
    });
  }

  return results;
}

function decodeDdgUrl(url: string): string {
  // DDG wraps URLs in /l/?uddg=<encoded>
  const match = url.match(/uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return url;
    }
  }
  return url;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
