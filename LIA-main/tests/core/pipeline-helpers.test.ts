import { describe, it, expect } from 'vitest';
import { buildFallbackResponse } from '@/lib/chat/pipeline-helpers';

describe('buildFallbackResponse', () => {
  it('returns Russian message without error detail by default', async () => {
    const res = buildFallbackResponse({});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('не получилось');
    expect(/[а-яё]/i.test(text)).toBe(true);
  });

  it('includes error detail when provided', async () => {
    const res = buildFallbackResponse({ errorMessage: '429 rate limit' });
    const text = await res.text();
    expect(text).toContain('429 rate limit');
  });
});
