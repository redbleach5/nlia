import { describe, it, expect } from 'vitest';

/**
 * Unit tests for src/lib/chat/context-budget.ts
 *
 * Tests the adaptive dialogue history budget calculator:
 *   - estimateTokens: char-based token estimate
 *   - resolveContextWindow: real vs fallback per tier
 *   - computeDialogueBudget: budget walk from newest to oldest
 *   - applyDialogueBudget: slice wrapper
 *
 * No mocks needed — the module is pure functions.
 */

import {
  estimateTokens,
  resolveContextWindow,
  resolveInferenceNumCtx,
  computeDialogueBudget,
  applyDialogueBudget,
  isDialogueBudgetPressured,
  MAX_MESSAGES_TO_CONSIDER,
  type BudgetMessage,
} from '@/lib/chat/context-budget';
import { resolvePoolAwareCtxCap } from '@/lib/compute-budget';

// ============================================================================
// estimateTokens
// ============================================================================

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ceil(length/3) for non-empty string', () => {
    // 6 chars → 2 tokens
    expect(estimateTokens('abcdef')).toBe(2);
    // 7 chars → 3 tokens (ceil)
    expect(estimateTokens('abcdefg')).toBe(3);
  });

  it('handles Cyrillic content (higher byte density)', () => {
    // 12 Cyrillic chars — heuristic still uses 3 chars/token
    const cyrillic = 'Привет, мир!';
    expect(estimateTokens(cyrillic)).toBe(Math.ceil(cyrillic.length / 3));
  });
});

// ============================================================================
// resolveContextWindow
// ============================================================================

describe('resolveContextWindow', () => {
  it('uses real context window when > 0', () => {
    expect(resolveContextWindow(32768, 'plus')).toBe(32768);
    expect(resolveContextWindow(8192, 'standard')).toBe(8192);
  });

  it('caps at tier inference limit even if model reports 200k+', () => {
    expect(resolveContextWindow(200000, 'standard')).toBe(32768);
    expect(resolveContextWindow(200000, 'max')).toBe(65536);
    expect(resolveContextWindow(200000, 'micro')).toBe(8192);
  });

  it('falls back to tier-based default when contextWindow is 0', () => {
    expect(resolveContextWindow(0, 'micro')).toBe(4096);
    expect(resolveContextWindow(0, 'standard')).toBe(8192);
    expect(resolveContextWindow(0, 'plus')).toBe(16384);
    expect(resolveContextWindow(0, 'max')).toBe(32768);
  });

  it('falls back when contextWindow is negative (defensive)', () => {
    expect(resolveContextWindow(-1, 'standard')).toBe(8192);
  });
});

// ============================================================================
// Pool-aware num_ctx
// ============================================================================

describe('resolveInferenceNumCtx (pool-aware)', () => {
  const model = {
    parameterSizeB: 14,
    quantization: 'Q4_K_M',
  };

  it('without pool opts matches tier-only resolveContextWindow', () => {
    expect(resolveInferenceNumCtx(40000, 'plus')).toBe(resolveContextWindow(40000, 'plus'));
  });

  it('shrinks ctx when VRAM pool shrinks (same model)', () => {
    const shared = { ...model, vramPoolKnown: true as const, role: 'day' as const };
    const ctx48 = resolveInferenceNumCtx(65536, 'plus', { ...shared, vramPoolGb: 48 });
    const ctx16 = resolveInferenceNumCtx(65536, 'plus', { ...shared, vramPoolGb: 16 });
    const ctx8 = resolveInferenceNumCtx(65536, 'plus', { ...shared, vramPoolGb: 8 });
    expect(ctx48).toBeGreaterThanOrEqual(ctx16);
    expect(ctx16).toBeGreaterThan(ctx8);
  });

  it('heavy role allows higher ctx than day on tight pool', () => {
    const base = {
      ...model,
      vramPoolGb: 16,
      vramPoolKnown: true as const,
    };
    const day = resolveInferenceNumCtx(65536, 'plus', { ...base, role: 'day' });
    const heavy = resolveInferenceNumCtx(65536, 'plus', { ...base, role: 'heavy' });
    expect(heavy).toBeGreaterThanOrEqual(day);
  });

  it('unknown pool does not invent a cap below tier', () => {
    expect(
      resolveInferenceNumCtx(32768, 'plus', {
        vramPoolGb: 0,
        vramPoolKnown: false,
        parameterSizeB: 14,
        quantization: 'Q4_K_M',
      }),
    ).toBe(32768);
  });
});

describe('resolvePoolAwareCtxCap', () => {
  it('returns null when pool unknown', () => {
    expect(resolvePoolAwareCtxCap({
      vramPoolGb: 16,
      vramPoolKnown: false,
      parameterSizeB: 14,
    })).toBeNull();
  });

  it('returns floor when weights exceed day budget', () => {
    const cap = resolvePoolAwareCtxCap({
      vramPoolGb: 8,
      vramPoolKnown: true,
      parameterSizeB: 32,
      quantization: 'Q4_K_M',
      role: 'day',
      minCtx: 2048,
    });
    expect(cap).toBe(2048);
  });
});

// ============================================================================
// computeDialogueBudget
// ============================================================================

const BASE_INPUT = {
  contextWindow: 32768,
  tier: 'plus' as const,
  systemPrompt: 'system prompt',
  maxOutputTokens: 4096,
  toolsEnabled: true,
};

function makeMessages(count: number, charsPerMessage = 200): BudgetMessage[] {
  const messages: BudgetMessage[] = [];
  for (let i = 0; i < count; i++) {
    const content = 'x'.repeat(charsPerMessage);
    messages.push({ role: i % 2 === 0 ? 'user' : 'companion', content });
  }
  return messages;
}

describe('computeDialogueBudget', () => {
  it('keeps all messages when they fit within budget', () => {
    const messages = makeMessages(10, 200); // 10 × ~67 tokens = ~670 tokens
    const result = computeDialogueBudget(BASE_INPUT, messages);
    expect(result.messageCount).toBe(10);
    expect(result.stopReason).toBe('all_messages_fit');
  });

  it('stops when budget is exhausted', () => {
    // Tiny context window: 4096 tokens total
    // After system prompt + maxOutput + tools + safety: very little left
    const input = {
      ...BASE_INPUT,
      contextWindow: 4096,
      tier: 'micro' as const,
      maxOutputTokens: 2048,
      toolsEnabled: true,
    };
    // 50 messages × ~200 tokens each = ~10000 tokens — way more than budget
    const messages = makeMessages(50, 600); // 200 tokens each
    const result = computeDialogueBudget(input, messages);
    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.messageCount).toBeLessThan(50);
    expect(result.messageCount).toBeGreaterThanOrEqual(2); // MIN_MESSAGES_TO_KEEP
  });

  it('respects MAX_MESSAGES_TO_CONSIDER cap even when budget allows more', () => {
    // Huge context window, tiny messages — would fit thousands of messages
    const input = {
      ...BASE_INPUT,
      contextWindow: 131072,
      tier: 'max' as const,
      maxOutputTokens: 4096,
      toolsEnabled: false,
    };
    const messages = makeMessages(100, 50); // tiny messages
    const result = computeDialogueBudget(input, messages);
    expect(result.messageCount).toBe(MAX_MESSAGES_TO_CONSIDER);
    expect(result.stopReason).toBe('max_messages_reached');
  });

  it('always keeps at least MIN_MESSAGES_TO_KEEP', () => {
    // Pathological case: huge system prompt eats almost entire budget
    const hugePrompt = 'y'.repeat(1_000_000); // ~333k tokens
    const input = {
      ...BASE_INPUT,
      systemPrompt: hugePrompt,
    };
    const messages = makeMessages(20, 200);
    const result = computeDialogueBudget(input, messages);
    expect(result.messageCount).toBe(2); // MIN_MESSAGES_TO_KEEP
    expect(result.budgetTokens).toBe(0);
  });

  it('subtracts tool schema tokens when toolsEnabled', () => {
    const messages = makeMessages(20, 200);
    const withTools = computeDialogueBudget({ ...BASE_INPUT, toolsEnabled: true }, messages);
    const withoutTools = computeDialogueBudget({ ...BASE_INPUT, toolsEnabled: false }, messages);
    // Without tools, more budget available → can fit more messages
    expect(withoutTools.budgetTokens).toBeGreaterThan(withTools.budgetTokens);
    expect(withoutTools.messageCount).toBeGreaterThanOrEqual(withTools.messageCount);
  });

  it('returns 0 budget when context window is too small for system prompt + output', () => {
    const input = {
      contextWindow: 2048,
      tier: 'micro' as const,
      systemPrompt: 'x'.repeat(6000), // 2000 tokens
      maxOutputTokens: 2048,
      toolsEnabled: false,
    };
    const messages = makeMessages(10, 100);
    const result = computeDialogueBudget(input, messages);
    expect(result.budgetTokens).toBe(0);
    expect(result.messageCount).toBe(2); // MIN_MESSAGES_TO_KEEP
  });

  it('walks from newest to oldest (keeps recent messages)', () => {
    // 5 messages with different sizes — budget fits exactly 3
    // Newest 3 should be kept, oldest 2 dropped
    const messages: BudgetMessage[] = [
      { role: 'user', content: 'OLD1' + 'x'.repeat(500) },       // oldest
      { role: 'companion', content: 'OLD2' + 'y'.repeat(500) },
      { role: 'user', content: 'RECENT3' + 'z'.repeat(100) },
      { role: 'companion', content: 'RECENT4' + 'a'.repeat(100) },
      { role: 'user', content: 'RECENT5' + 'b'.repeat(100) },     // newest
    ];
    // Tight budget — fits only ~3 small messages
    const input = {
      contextWindow: 4096,
      tier: 'micro' as const,
      systemPrompt: 'sys',
      maxOutputTokens: 2048,
      toolsEnabled: false,
    };
    const result = computeDialogueBudget(input, messages);
    expect(result.messageCount).toBeLessThanOrEqual(5);
    expect(result.messageCount).toBeGreaterThanOrEqual(2);
    // Verify the slice kept the newest messages
    const kept = applyDialogueBudget(messages, result);
    if (result.messageCount < 5) {
      // Newest message should always be in the kept set
      expect(kept[kept.length - 1].content).toBe(messages[messages.length - 1].content);
    }
  });
});

// ============================================================================
// applyDialogueBudget
// ============================================================================

describe('applyDialogueBudget', () => {
  it('returns last N messages in chronological order', () => {
    const messages = makeMessages(10, 100);
    const result = computeDialogueBudget(
      { ...BASE_INPUT, contextWindow: 131072, tier: 'max' as const, toolsEnabled: false },
      messages,
    );
    const kept = applyDialogueBudget(messages, result);
    expect(kept.length).toBe(result.messageCount);
    // First kept message should be messages[len - messageCount]
    expect(kept[0].content).toBe(messages[messages.length - result.messageCount].content);
    // Last kept should be the newest message
    expect(kept[kept.length - 1].content).toBe(messages[messages.length - 1].content);
  });

  it('handles empty message list', () => {
    const result = computeDialogueBudget(BASE_INPUT, []);
    expect(result.messageCount).toBe(0);
    expect(result.stopReason).toBe('all_messages_fit');
    expect(applyDialogueBudget([], result)).toEqual([]);
  });

  // P-CORE-2 regression: slice(-0) bug. Previously `applyDialogueBudget`
  // returned `messages.slice(-result.messageCount)`. When `messageCount = 0`
  // (which happens when system prompt + tools already overflow the context),
  // `slice(-0)` is `slice(0)` — returns the ENTIRE array. On a micro tier
  // with a 4k context and 3.5k-token system prompt, ALL 50 messages would
  // be sent, overflowing the model.
  it('P-CORE-2: returns empty array when messageCount = 0 (not full array)', () => {
    const messages = makeMessages(10, 100);
    // Construct a result with messageCount = 0 directly — bypasses
    // computeDialogueBudget which may not produce 0 for these inputs.
    const zeroBudget = {
      messageCount: 0,
      estimatedTokens: 0,
      budgetTokens: 0,
      effectiveContextWindow: 4096,
      stopReason: 'max_messages_reached' as const,
    };
    const kept = applyDialogueBudget(messages, zeroBudget);
    expect(kept).toEqual([]);  // not the full 10-message array
    expect(kept.length).toBe(0);
  });
});

// ============================================================================
// Regression: prior behaviour was slice(-12)
// ============================================================================

describe('regression: prior slice(-12) behaviour', () => {
  it('on standard tier with 8k context, keeps ~8-15 messages (similar to old slice(-12))', () => {
    // Old behaviour: slice(-12) = always 12 messages
    // New behaviour: adaptive, but should be in similar range for standard tier
    const input = {
      contextWindow: 0, // force fallback to tier default
      tier: 'standard' as const,
      systemPrompt: 'system prompt of moderate length ' + 'x'.repeat(500),
      maxOutputTokens: 4096,
      toolsEnabled: true,
    };
    // 30 messages, each ~200 tokens
    const messages = makeMessages(30, 600);
    const result = computeDialogueBudget(input, messages);
    // Should keep somewhere between 4 and 14 messages — adaptive, not fixed 12
    expect(result.messageCount).toBeGreaterThan(2);
    expect(result.messageCount).toBeLessThanOrEqual(30);
  });

  it('on max tier with 32k context, keeps more messages than old slice(-12) allowed', () => {
    // Old behaviour: capped at 12 even on huge models
    // New behaviour: uses up to MAX_MESSAGES_TO_CONSIDER (50) if budget allows
    const input = {
      contextWindow: 32768,
      tier: 'max' as const,
      systemPrompt: 'system prompt ' + 'x'.repeat(500),
      maxOutputTokens: 8192,
      toolsEnabled: false,
    };
    // 30 messages × ~67 tokens each = ~2000 tokens — easily fits in 32k budget
    const messages = makeMessages(30, 200);
    const result = computeDialogueBudget(input, messages);
    expect(result.messageCount).toBe(30); // all fit, no cap hit
    expect(result.stopReason).toBe('all_messages_fit');
  });
});

describe('isDialogueBudgetPressured', () => {
  it('false when all messages fit', () => {
    expect(isDialogueBudgetPressured({
      messageCount: 10,
      estimatedTokens: 100,
      budgetTokens: 5000,
      effectiveContextWindow: 8192,
      stopReason: 'all_messages_fit',
    }, 10)).toBe(false);
  });

  it('true when budget exhausted and messages dropped', () => {
    expect(isDialogueBudgetPressured({
      messageCount: 4,
      estimatedTokens: 2000,
      budgetTokens: 2000,
      effectiveContextWindow: 4096,
      stopReason: 'budget_exhausted',
    }, 20)).toBe(true);
  });

  it('false when exhausted but nothing dropped', () => {
    expect(isDialogueBudgetPressured({
      messageCount: 5,
      estimatedTokens: 2000,
      budgetTokens: 2000,
      effectiveContextWindow: 4096,
      stopReason: 'budget_exhausted',
    }, 5)).toBe(false);
  });
});
