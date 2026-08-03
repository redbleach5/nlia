/**
 * Derive a short episode title from the first user message.
 * Shared by client (optimistic UI) and server (autoTitleEpisode).
 */
export function deriveEpisodeTitle(firstUserMessage: string, maxLen = 60): string | null {
  const cleaned = firstUserMessage
    .replace(/[*_`#>~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.lastIndexOf(' ', maxLen);
  return `${cleaned.slice(0, cut > 20 ? cut : maxLen)}…`;
}
