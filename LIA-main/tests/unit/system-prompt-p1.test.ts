import { describe, it, expect } from 'vitest';
import { resolveChatPromptProfile } from '@/lib/prompts/chat-profile';
import { buildSystemPrompt, buildPlaybooksForProfile } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

describe('chat prompt profile P1', () => {
  it('resolveChatPromptProfile routes trivial to companion', () => {
    expect(resolveChatPromptProfile({
      toolsEnabled: true,
      isTrivial: true,
      isAgent: false,
      isKbQuestion: false,
      hasKbContext: false,
      hasWebContext: false,
      isCodeTask: false,
      complexity: 'trivial',
    })).toBe('companion');
  });

  it('resolveChatPromptProfile routes KB to assistant', () => {
    expect(resolveChatPromptProfile({
      toolsEnabled: true,
      isTrivial: false,
      isAgent: false,
      isKbQuestion: true,
      hasKbContext: false,
      hasWebContext: false,
      isCodeTask: false,
      complexity: 'simple',
    })).toBe('assistant');
  });

  it('companion profile has no tool playbooks', () => {
    const pb = buildPlaybooksForProfile('companion', {
      promptMode: 'adaptive',
      toolsEnabled: true,
      isTrivial: true,
      isKbQuestion: false,
      isWebSearch: false,
      isAgent: false,
      isEmotional: true,
      isCodeTask: false,
      complexity: 'trivial',
    });
    expect(pb).toBe('');
  });

  it('system prompt includes character summary', () => {
    const prompt = buildSystemPrompt({
      emotion: createInitialEmotion(),
      tier: 'standard',
      isTrivialGreeting: true,
    });
    expect(prompt).toContain('Ты — Лия, женщина, живой собеседник');
    expect(prompt).not.toContain('=== ТВОИ ЦЕННОСТИ ===');
  });

  it('promptMode full uses assistant playbooks even for companion routing', () => {
    const prompt = buildSystemPrompt({
      emotion: createInitialEmotion(),
      tier: 'standard',
      toolsEnabled: true,
      promptMode: 'full',
    });
    expect(prompt).toContain('search_sources');
  });
});
