// Shared client+server markers for chat stream failures.
// Mid-stream errors cannot change HTTP status (headers already sent), so the
// body carries a sentinel prefix; use-chat strips it and shows a toast instead
// of treating the text as Lia's reply.

export const LIA_STREAM_ERROR_PREFIX = '\u2060LIA_ERR:';

export function encodeStreamErrorMessage(userVisible: string): string {
  return `${LIA_STREAM_ERROR_PREFIX}${userVisible}`;
}

/** If `text` is a pure or trailing stream-error payload, return the user message. */
export function parseStreamErrorPayload(text: string): {
  partial: string;
  error: string;
} | null {
  const idx = text.indexOf(LIA_STREAM_ERROR_PREFIX);
  if (idx < 0) return null;
  return {
    partial: text.slice(0, idx),
    error: text.slice(idx + LIA_STREAM_ERROR_PREFIX.length).trim() || 'Не удалось получить ответ.',
  };
}
