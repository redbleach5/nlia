/**
 * Parse KB citation hrefs from markdown.
 * Supports: #source:SOURCE_ID  and  #source:SOURCE_ID:CHUNK_ID
 */
export function parseSourceCitationHref(href: string): { sourceId: string; chunkId?: string } | null {
  if (!href.startsWith('#source:')) return null;
  const rest = href.slice('#source:'.length).trim();
  if (!rest) return null;
  const colon = rest.indexOf(':');
  if (colon <= 0) {
    return { sourceId: rest };
  }
  const sourceId = rest.slice(0, colon);
  const chunkId = rest.slice(colon + 1).trim();
  if (!sourceId) return null;
  return chunkId ? { sourceId, chunkId } : { sourceId };
}

/** Build markdown citation link for prompts / model output. */
export function formatSourceCitationMarkdown(
  label: string,
  sourceId: string,
  chunkId?: string | null,
): string {
  const safeLabel = label.replace(/[\[\]]/g, '');
  const href = chunkId
    ? `#source:${sourceId}:${chunkId}`
    : `#source:${sourceId}`;
  return `[${safeLabel}](${href})`;
}
