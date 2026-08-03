/**
 * Fetch page tool — real implementation (replaces M5 stub).
 * Per docs/ARCHITECTURE.md § 8.2 (category D: Web tools).
 *
 * Fetches a web page, extracts readable text content.
 * Uses Readability-style heuristics (strip nav/footer/scripts).
 */

import { safeFetch } from "../../infra/ssrf.js";
import { logger } from "../../util/logger.js";

const MAX_CONTENT_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 20_000;

export async function fetchPage(url: string): Promise<{
  url: string;
  title: string | null;
  content: string;
  truncated: boolean;
  mimeType: string | null;
}> {
  try {
    const res = await safeFetch(url, {
      headers: {
        "User-Agent": "Lia/3.0 (local AI companion)",
        "Accept": "text/html,application/xhtml+xml,text/plain",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const html = await res.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? stripHtml(titleMatch[1]!).trim() : null;

    // Extract readable content
    let content: string;
    if (contentType.includes("text/plain")) {
      content = html;
    } else {
      content = extractReadableText(html);
    }

    const truncated = content.length > MAX_CONTENT_CHARS;
    if (truncated) {
      content = content.slice(0, MAX_CONTENT_CHARS) + "\n…[truncated]";
    }

    logger.info({ url, title: title?.slice(0, 60), contentLength: content.length }, "page fetched");
    return { url, title, content, truncated, mimeType: contentType.split(";")[0] ?? null };
  } catch (e) {
    logger.warn({ err: e, url }, "fetch page failed");
    throw new Error(`Failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Simple readability extraction.
 * Strips scripts, styles, nav, footer; extracts text from main content.
 */
function extractReadableText(html: string): string {
  // Remove scripts, styles, noscript
  let cleaned = html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<noscript[^>]*>.*?<\/noscript>/gis, "")
    .replace(/<nav[^>]*>.*?<\/nav>/gis, "")
    .replace(/<footer[^>]*>.*?<\/footer>/gis, "")
    .replace(/<header[^>]*>.*?<\/header>/gis, "")
    .replace(/<aside[^>]*>.*?<\/aside>/gis, "");

  // Try to find <main> or <article> content
  const mainMatch = cleaned.match(/<(?:main|article)[^>]*>(.*?)<\/(?:main|article)>/is);
  if (mainMatch) {
    cleaned = mainMatch[1]!;
  }

  // Convert <p>, <br>, <h1>-<h6> to newlines
  cleaned = cleaned
    .replace(/<(p|div|h[1-6]|br|li|tr)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  // Decode entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Normalize whitespace
  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}
