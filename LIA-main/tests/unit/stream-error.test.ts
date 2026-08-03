import { describe, expect, it } from 'vitest';
import {
  LIA_STREAM_ERROR_PREFIX,
  encodeStreamErrorMessage,
  parseStreamErrorPayload,
} from '@/lib/chat/stream-error';

describe('stream-error markers', () => {
  it('encodes and parses a pure error payload', () => {
    const encoded = encodeStreamErrorMessage('Нет связи с Ollama');
    expect(encoded.startsWith(LIA_STREAM_ERROR_PREFIX)).toBe(true);
    const parsed = parseStreamErrorPayload(encoded);
    expect(parsed).toEqual({ partial: '', error: 'Нет связи с Ollama' });
  });

  it('keeps partial content when error is appended mid-stream', () => {
    const partial = 'Начало ответа…';
    const encoded = partial + encodeStreamErrorMessage('Stream прерван');
    const parsed = parseStreamErrorPayload(encoded);
    expect(parsed).toEqual({ partial, error: 'Stream прерван' });
  });

  it('returns null for normal Lia text', () => {
    expect(parseStreamErrorPayload('Привет, как дела?')).toBeNull();
  });
});
