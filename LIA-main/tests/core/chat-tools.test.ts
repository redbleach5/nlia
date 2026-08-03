import { describe, it, expect } from 'vitest';
import { decideChatTools } from '@/lib/chat/chat-tools';

describe('decideChatTools', () => {
  const base = {
    planToolsEnabled: true,
    toolsSupported: true,
    kbAnswerLocked: false,
    webSearchContext: undefined as string | undefined,
  };

  it('enables tools when plan allows and no RAG lock', () => {
    expect(decideChatTools(base)).toBe(true);
  });

  it('disables tools when proactive web search injected context (prod regression)', () => {
    expect(decideChatTools({
      ...base,
      webSearchContext: '🔍 АКТУАЛЬНЫЕ РЕЗУЛЬТАТЫ ПОИСКА',
    })).toBe(false);
  });

  it('disables tools when KB answer is locked', () => {
    expect(decideChatTools({ ...base, kbAnswerLocked: true })).toBe(false);
  });

  it('disables tools when plan.toolsEnabled is false', () => {
    expect(decideChatTools({ ...base, planToolsEnabled: false })).toBe(false);
  });

  it('disables tools when model does not support tool calling', () => {
    expect(decideChatTools({ ...base, toolsSupported: false })).toBe(false);
  });

  it('disables tools when both web context and KB lock are set', () => {
    expect(decideChatTools({
      ...base,
      webSearchContext: 'search results',
      kbAnswerLocked: true,
    })).toBe(false);
  });

  it('disables tools on trivial/simple complexity (latency pass)', () => {
    expect(decideChatTools({ ...base, complexity: 'trivial' })).toBe(false);
    expect(decideChatTools({ ...base, complexity: 'simple' })).toBe(false);
  });

  it('disables tools for companion/minimal profile', () => {
    expect(decideChatTools({ ...base, complexity: 'moderate', chatProfile: 'companion' })).toBe(false);
    expect(decideChatTools({ ...base, complexity: 'moderate', chatProfile: 'minimal' })).toBe(false);
  });

  it('enables tools on moderate without lock', () => {
    expect(decideChatTools({ ...base, complexity: 'moderate' })).toBe(true);
  });
});
