import 'server-only';

// web_search — DuckDuckGo HTML scraping (no API key required).
// + fetch_page — чтение содержимого веб-страницы с извлечением текста.

import { logger } from '@/lib/logger';
import { assertSafeUrl, assertSafeHost, assertAllowedMethod } from '@/lib/infra/ssrf';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/**
 * Поиск через DuckDuckGo HTML endpoint. Возвращает топ-10 результатов.
 * Без API ключа, без rate limits (в разумных пределах).
 */
export async function webSearch(query: string): Promise<{
  query: string;
  results: SearchResult[];
  count: number;
}> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const startMs = Date.now();

  try {
    logger.debug('tools', `web_search: ${query.slice(0, 80)}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      logger.warn('tools', `web_search HTTP error`, { status: res.status, query: query.slice(0, 80) });
      return { query, results: [], count: 0 };
    }

    const html = await res.text();
    const results = parseDuckDuckGoHtml(html);
    logger.info('tools', `web_search done (${Date.now() - startMs}ms)`, {
      query: query.slice(0, 80),
      resultsCount: results.length,
    });

    return { query, results, count: results.length };
  } catch (e) {
    logger.warn('tools', `web_search failed`, { query: query.slice(0, 80) }, e);
    return { query, results: [], count: 0 };
  }
}

/**
 * Загрузить веб-страницу и извлечь читаемый текст.
 *
 * Удаляет HTML-теги, скрипты, стили, навигацию.
 * Возвращает первые N символов чистого текста.
 *
 * Используется агентом после web_search для чтения конкретных страниц
 * (API-документация, туториалы, примеры кода).
 *
 * SSRF-защита: URL проверяется через assertSafeUrl перед fetch.
 * Redirects обрабатываются вручную — каждый target перепроверяется.
 */
export async function fetchPage(url: string, maxChars = 5000): Promise<{
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  error?: string;
}> {
  const startMs = Date.now();
  logger.debug('tools', `fetch_page: ${url.slice(0, 100)}`, { maxChars });

  try {
    // SSRF check — проверяем исходный URL перед первым запросом
    await assertSafeUrl(url);
    assertAllowedMethod('GET');

    // Manual redirect following — перепроверяем каждый redirect target
    let currentUrl = url;
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;
    let res: Response;

    while (true) {
      res = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(20_000),
        redirect: 'manual',
      });

      // Check for redirect
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        if (++redirectCount > MAX_REDIRECTS) {
          return { url, title: '', text: '', truncated: false, error: `too many redirects (max ${MAX_REDIRECTS})` };
        }
        const redirectUrl = new URL(location, currentUrl);
        // SSRF check on redirect target
        await assertSafeHost(redirectUrl.hostname);
        currentUrl = redirectUrl.toString();
        continue;
      }
      break;
    }

    if (!res.ok) {
      logger.warn('tools', `fetch_page HTTP error`, { url: url.slice(0, 100), status: res.status });
      return { url, title: '', text: '', truncated: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') ?? '';

    // For non-HTML (JSON, plain text) — return as-is
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const text = await res.text();
      logger.info('tools', `fetch_page done (${Date.now() - startMs}ms) — plain text`, {
        url: url.slice(0, 100), textLength: text.length, truncated: text.length > maxChars,
      });
      return {
        url,
        title: '',
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    }

    // For HTML — extract readable text
    const html = await res.text();
    const { title, text } = extractReadableText(html, maxChars);
    logger.info('tools', `fetch_page done (${Date.now() - startMs}ms) — HTML extracted`, {
      url: url.slice(0, 100),
      title: title.slice(0, 80),
      textLength: text.length,
    });

    // SPA / empty shell pages (e.g. three.js demos) yield almost no text —
    // tell the model explicitly so it answers from search snippets or picks
    // a GitHub/raw/docs URL instead of pretending the page was useful.
    if (text.trim().length < 40) {
      return {
        url,
        title,
        text: '',
        truncated: false,
        error:
          'Page has almost no extractable text (likely client-rendered / empty shell). ' +
          'Try a URL with static documentation or source text; otherwise answer from web_search snippets.',
      };
    }

    return {
      url,
      title,
      text,
      truncated: html.length > maxChars * 3,  // rough estimate
    };
  } catch (e) {
    logger.warn('tools', `fetch_page failed`, { url: url.slice(0, 100) }, e);
    return {
      url,
      title: '',
      text: '',
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Извлечь читаемый текст из HTML.
 *
 * Удаляет: script, style, nav, footer, header, noscript теги.
 * Извлекает: <title>, <h1>-<h3>, <p>, <pre>, <code>, <li>, <td>.
 * Сохраняет структуру: заголовки на отдельных строках, код в блоках.
 */
function extractReadableText(html: string, maxChars: number): { title: string; text: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // Remove script, style, nav, footer, header, noscript, svg
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract code blocks first — they're the most valuable for developer docs
  const codeBlocks: string[] = [];
  cleaned = cleaned.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const text = stripHtml(code).trim();
    if (text.length > 0 && text.length < 2000) {
      codeBlocks.push(text);
    }
    return '\n\n[CODE BLOCK]\n' + text + '\n[/CODE BLOCK]\n\n';
  });

  // Extract inline code
  cleaned = cleaned.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    return '`' + stripHtml(code).trim() + '`';
  });

  // Replace headings with markers
  cleaned = cleaned
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n## $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n### $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n#### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n##### $1\n');

  // Replace paragraphs and list items with newlines
  cleaned = cleaned
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n');

  // Strip all remaining HTML tags
  cleaned = stripHtml(cleaned);

  // Clean up whitespace
  cleaned = cleaned
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .trim();

  // Truncate to maxChars, trying to end on a newline
  if (cleaned.length > maxChars) {
    const cut = cleaned.slice(0, maxChars);
    const lastNewline = cut.lastIndexOf('\n');
    cleaned = (lastNewline > maxChars * 0.8 ? cut.slice(0, lastNewline) : cut) + '\n...[truncated]';
  }

  return { title, text: cleaned };
}

/**
 * Парсит HTML-ответ DuckDuckGo. DDG использует .result blocks с .result__a (title+link)
 * и .result__snippet.
 */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Simpler approach: find all result__a links
  const linkOnlyRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;

  let match: RegExpExecArray | null;
  const seenUrls = new Set<string>();

  while ((match = linkOnlyRegex.exec(html)) && results.length < 10) {
    let href = match[1];
    const titleHtml = match[2];

    // DDG wraps URLs: href="//duckduckgo.com/l/?uddg=ENCODED_URL&rut=..."
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        href = decodeURIComponent(uddgMatch[1]);
      } catch {
        continue;
      }
    } else if (href.startsWith('//')) {
      href = 'https:' + href;
    }

    // Skip DDG-internal links
    if (href.includes('duckduckgo.com') && !uddgMatch) continue;
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);

    const title = stripHtml(titleHtml).trim();
    if (!title) continue;

    // Find snippet — look for the next result__snippet after this link
    const matchIndex = match.index ?? 0;
    const afterLink = html.slice(matchIndex + match[0].length);
    const snippetMatch = afterLink.match(snippetRegex);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

    results.push({ title, url: href, snippet });
  }

  return results;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
