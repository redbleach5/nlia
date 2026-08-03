import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildPlaybooksForProfile } from '@/lib/system-prompt';
import { createInitialEmotion } from '@/lib/emotion';

describe('system prompt P0', () => {
  const emotion = createInitialEmotion();

  it('trivial adaptive prompt omits KB/tool playbooks', () => {
    const prompt = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: true,
      isTrivialGreeting: true,
      promptMode: 'adaptive',
    });
    expect(prompt).not.toContain('search_sources');
    expect(prompt).toContain('1–2 предложения');
    expect(prompt).toContain('СОСТОЯНИЕ ДИАЛОГА');
    expect(prompt).toContain('mayGreet=true');
    expect(prompt).toContain('коротко поздоровайся');
    expect(prompt).toContain('ОДИН ВОПРОС');
  });

  it('trivial prompt is shorter than full tool playbook prompt', () => {
    const trivial = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: true,
      isTrivialGreeting: true,
      promptMode: 'adaptive',
    });
    const full = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: true,
      promptMode: 'full',
    });
    expect(trivial.length).toBeLessThan(full.length - 200);
  });

  it('tools disabled skips playbooks', () => {
    const pb = buildPlaybooksForProfile('minimal', {
      promptMode: 'full',
      toolsEnabled: false,
      isTrivial: false,
      isKbQuestion: true,
      isWebSearch: false,
      isAgent: false,
      isEmotional: true,
      isCodeTask: false,
      complexity: 'moderate',
    });
    expect(pb).toBe('');
  });

  it('omits web_search tier hint when tools off or KB context present', () => {
    const withTools = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: true,
    });
    expect(withTools).toMatch(/Для фактологических \(версии, даты, API\) — используй web_search/);

    const noTools = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: false,
    });
    expect(noTools).not.toMatch(/Для фактологических \(версии, даты, API\) — используй web_search/);

    const withKb = buildSystemPrompt({
      emotion,
      tier: 'standard',
      toolsEnabled: true,
      kbSearchContext: 'фрагмент из базы',
    });
    expect(withKb).not.toMatch(/Для фактологических \(версии, даты, API\) — используй web_search/);
  });
});