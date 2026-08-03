import { describe, it, expect } from 'vitest';

/**
 * Regression tests for prompt prefix-cache ordering.
 *
 * The system prompt must be structured so that:
 *   - Stable sections (tier, self-awareness, user profile, episode facts,
 *     episode summary, emotional anchors, open tasks) come BEFORE
 *     volatile sections (liaDecision, emotion, web/KB search context,
 *     RAG hits, recent messages).
 *   - This maximises Ollama KV-cache prefix reuse across consecutive
 *     turns in the same episode.
 *
 * These tests assert structural invariants on the generated prompt string.
 * They do NOT check the exact content (which is covered by other tests) —
 * they check the ORDER, which is the cache-relevant property.
 */

import { buildSystemPrompt } from '@/lib/system-prompt';
import type { SystemPromptContext } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';
import type { LiaDecision } from '@/lib/identity/decision';

// ============================================================================
// Helpers
// ============================================================================

const BASE_EMOTION = createInitialEmotion();

const BASE_DECISION: LiaDecision = {
  action: 'help',
  desiredTone: 'warm',
  willingnessToHelp: 0.8,
  emotionalExpression: 'warmth',
  confidence: 0.7,
  motivation: 'user asked a clear question',
  decidedAt: Date.now(),
};

function makeCtx(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    emotion: BASE_EMOTION,
    tier: 'plus',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('prompt prefix-cache ordering', () => {
  it('places user profile before liaDecision', () => {
    const ctx = makeCtx({
      userProfile: 'USER_PROFILE_MARKER',
      liaDecision: BASE_DECISION,
    });
    const prompt = buildSystemPrompt(ctx);
    const profileIdx = prompt.indexOf('USER_PROFILE_MARKER');
    const decisionIdx = prompt.indexOf('Ты решила как ответить');
    expect(profileIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeLessThan(decisionIdx);
  });

  it('places episode facts before liaDecision', () => {
    const ctx = makeCtx({
      episodeFacts: 'EPISODE_FACTS_MARKER',
      liaDecision: BASE_DECISION,
    });
    const prompt = buildSystemPrompt(ctx);
    const factsIdx = prompt.indexOf('EPISODE_FACTS_MARKER');
    const decisionIdx = prompt.indexOf('Ты решила как ответить');
    expect(factsIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeGreaterThan(0);
    expect(factsIdx).toBeLessThan(decisionIdx);
  });

  it('places episode summary before liaDecision', () => {
    const ctx = makeCtx({
      episodeSummary: 'EPISODE_SUMMARY_MARKER',
      liaDecision: BASE_DECISION,
    });
    const prompt = buildSystemPrompt(ctx);
    const summaryIdx = prompt.indexOf('EPISODE_SUMMARY_MARKER');
    const decisionIdx = prompt.indexOf('Ты решила как ответить');
    expect(summaryIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeLessThan(decisionIdx);
  });

  it('does not place emotional anchors in the prompt', () => {
    const ctx = makeCtx({
      emotionalAnchors: 'EMOTIONAL_ANCHORS_MARKER',
      liaDecision: BASE_DECISION,
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('EMOTIONAL_ANCHORS_MARKER');
    expect(prompt).toContain('Ты решила как ответить');
  });

  it('places open tasks before web/KB search context', () => {
    // openTasks requires isAgent || isCodeTask in adaptive mode. Use agent mode.
    const ctx = makeCtx({
      mode: 'agent',
      openTasks: 'OPEN_TASKS_MARKER',
      webSearchContext: 'WEB_SEARCH_MARKER',
    });
    const prompt = buildSystemPrompt(ctx);
    const tasksIdx = prompt.indexOf('OPEN_TASKS_MARKER');
    const webIdx = prompt.indexOf('WEB_SEARCH_MARKER');
    expect(tasksIdx).toBeGreaterThan(0);
    expect(webIdx).toBeGreaterThan(0);
    expect(tasksIdx).toBeLessThan(webIdx);
  });

  it('places user profile before web search context', () => {
    const ctx = makeCtx({
      userProfile: 'USER_PROFILE_MARKER',
      webSearchContext: 'WEB_SEARCH_MARKER',
    });
    const prompt = buildSystemPrompt(ctx);
    const profileIdx = prompt.indexOf('USER_PROFILE_MARKER');
    const webIdx = prompt.indexOf('WEB_SEARCH_MARKER');
    expect(profileIdx).toBeGreaterThan(0);
    expect(webIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeLessThan(webIdx);
  });

  it('places episode summary before dialogue turn contract', () => {
    const ctx = makeCtx({
      episodeSummary: 'EPISODE_SUMMARY_MARKER',
      episodeHasPriorGreeting: true,
      episodeUserTurnCount: 3,
    });
    const prompt = buildSystemPrompt(ctx);
    const summaryIdx = prompt.indexOf('EPISODE_SUMMARY_MARKER');
    const stateIdx = prompt.indexOf('СОСТОЯНИЕ ДИАЛОГА');
    expect(summaryIdx).toBeGreaterThan(0);
    expect(stateIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeLessThan(stateIdx);
  });

  it('keeps character summary at the very start of the prompt', () => {
    const ctx = makeCtx();
    const prompt = buildSystemPrompt(ctx);
    expect(prompt.startsWith('Ты — Лия')).toBe(true);
  });

  it('does not inject painfulAnchor into the prompt', () => {
    const ctx = makeCtx({
      liaDecision: BASE_DECISION,
      painfulAnchor: {
        kind: 'painful_anchor',
        emotion: 'sadness',
        intensity: 0.9,
        currentToneNeutral: true,
      },
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Ты решила как ответить');
    expect(prompt).not.toContain('painful_anchor:');
  });

  it('does not lose core sections when all are provided', () => {
    // Emotional anchors are stored but not injected (prompt theater removed).
    // recentLiaMessages is deprecated and ignored (toxic few-shot).
    const ctx = makeCtx({
      promptMode: 'full',
      userProfile: 'USER_PROFILE_MARKER',
      episodeFacts: 'EPISODE_FACTS_MARKER',
      episodeSummary: 'EPISODE_SUMMARY_MARKER',
      emotionalAnchors: 'EMOTIONAL_ANCHORS_MARKER',
      painfulAnchor: {
        kind: 'painful_anchor',
        emotion: 'anxiety',
        intensity: 0.85,
        currentToneNeutral: true,
      },
      openTasks: 'OPEN_TASKS_MARKER',
      ragHits: 'RAG_HITS_MARKER',
      recentLiaMessages: 'RECENT_LIA_MESSAGES_MARKER',
      webSearchContext: 'WEB_SEARCH_MARKER',
      kbSearchContext: 'KB_SEARCH_MARKER',
      liaDecision: BASE_DECISION,
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('USER_PROFILE_MARKER');
    expect(prompt).toContain('EPISODE_FACTS_MARKER');
    expect(prompt).toContain('EPISODE_SUMMARY_MARKER');
    expect(prompt).not.toContain('EMOTIONAL_ANCHORS_MARKER');
    expect(prompt).not.toContain('painful_anchor:');
    expect(prompt).toContain('OPEN_TASKS_MARKER');
    expect(prompt).toContain('RAG_HITS_MARKER');
    expect(prompt).not.toContain('RECENT_LIA_MESSAGES_MARKER');
    expect(prompt).toContain('СОСТОЯНИЕ ДИАЛОГА');
    expect(prompt).toContain('WEB_SEARCH_MARKER');
    expect(prompt).toContain('KB_SEARCH_MARKER');
    expect(prompt).toContain('Ты решила как ответить');
  });
});

// ============================================================================
// Regression: prior behaviour
// ============================================================================

describe('regression: prior prompt structure preserved', () => {
  it('produces a non-empty prompt for default context', () => {
    const prompt = buildSystemPrompt(makeCtx());
    expect(prompt.length).toBeGreaterThan(1000);
  });

  it('produces a longer prompt when all optional sections are provided', () => {
    const base = buildSystemPrompt(makeCtx()).length;
    const full = buildSystemPrompt(makeCtx({
      userProfile: 'x'.repeat(100),
      episodeFacts: 'x'.repeat(100),
      episodeSummary: 'x'.repeat(100),
      emotionalAnchors: 'x'.repeat(100),
      openTasks: 'x'.repeat(100),
      ragHits: 'x'.repeat(100),
      webSearchContext: 'x'.repeat(100),
    })).length;
    expect(full).toBeGreaterThan(base + 500);
  });
});

describe('liaDecision inject: motivation + presence', () => {
  it('includes truncated motivation as внутренняя опора', () => {
    const prompt = buildSystemPrompt(makeCtx({
      liaDecision: {
        ...BASE_DECISION,
        motivation: 'Хочу ответить коротко и по-человечески, без инструктажа',
      },
    }));
    expect(prompt).toContain('Внутренняя опора:');
    expect(prompt).toContain('по-человечески');
    expect(prompt).toContain('Как это звучит:');
  });

  it('emotional_response uses presence hint and soft length', () => {
    const prompt = buildSystemPrompt(makeCtx({
      liaDecision: {
        ...BASE_DECISION,
        action: 'emotional_response',
        desiredTone: 'concerned',
        willingnessToHelp: 0.9,
        emotionalExpression: 'concern',
        motivation: 'Рядом важнее советов',
      },
    }));
    expect(prompt).toContain('без режима «разберём задачу по пунктам»');
    expect(prompt).toContain('живой ответ рядом');
  });

  it('playful help avoids service-mode length essay', () => {
    const prompt = buildSystemPrompt(makeCtx({
      liaDecision: {
        ...BASE_DECISION,
        action: 'help',
        desiredTone: 'playful',
        willingnessToHelp: 0.9,
        emotionalExpression: 'playfulness',
      },
    }));
    expect(prompt).toContain('не превращай ответ в инструктаж');
  });
});
