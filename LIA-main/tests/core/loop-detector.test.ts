import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ollama', () => ({
  embed: vi.fn(async (text: string) => {
    const vec = new Float32Array(768);
    for (let i = 0; i < vec.length; i++) {
      vec[i] = Math.sin((text.charCodeAt(i % text.length) + i) * 0.13);
    }
    return vec;
  }),
}));

import { detectLoop, type Step } from '@/lib/agent/loop-detector';

function step(partial: Partial<Step> & Pick<Step, 'action' | 'observation'>): Step {
  return {
    thought: partial.thought ?? 'thinking',
    input: partial.input ?? {},
    ...partial,
  };
}

describe('detectLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects pattern loop when same tool+input repeats more than twice', async () => {
    const input = { path: 'foo.txt' };
    const steps: Step[] = [
      step({ action: 'read_file', input, observation: 'ok 1' }),
      step({ action: 'read_file', input, observation: 'ok 2' }),
      step({ action: 'read_file', input, observation: 'ok 3' }),
    ];
    const signal = await detectLoop(steps);
    expect(signal?.kind).toBe('pattern');
    if (signal?.kind === 'pattern') {
      expect(signal.tool).toBe('read_file');
      expect(signal.count).toBeGreaterThan(2);
    }
  });

  it('detects empty loop after three short observations', async () => {
    const steps: Step[] = [
      step({ action: 'web_search', input: { q: 'a' }, observation: '' }),
      step({ action: 'web_search', input: { q: 'b' }, observation: '   ' }),
      step({ action: 'list_dir', input: { path: '.' }, observation: 'none' }),
    ];
    const signal = await detectLoop(steps);
    expect(signal?.kind).toBe('empty');
  });

  it('does not treat ECONNREFUSED observations as empty loop', async () => {
    const steps: Step[] = [
      step({ thought: 'first attempt', action: 'web_search', input: { q: 'a' }, observation: '' }),
      step({ thought: 'second attempt after error', action: 'web_search', input: { q: 'b' }, observation: 'connect ECONNREFUSED 127.0.0.1' }),
      step({ thought: 'third attempt different angle', action: 'web_search', input: { q: 'c' }, observation: '' }),
    ];
    const signal = await detectLoop(steps);
    expect(signal).toBeNull();
  });

  it('returns null for diverse successful steps', async () => {
    const steps: Step[] = [
      step({ action: 'read_file', input: { path: 'a' }, observation: 'file contents here are long enough' }),
      step({ action: 'write_file', input: { path: 'b' }, observation: 'written successfully with details' }),
    ];
    expect(await detectLoop(steps)).toBeNull();
  });

  it('skips semantic loop when KB file content was already retrieved', async () => {
    const sameThought = 'Нужно кратко описать протокол EGTS для пользователя на основе прочитанного файла';
    const steps: Step[] = [
      step({
        thought: 'search and read',
        action: 'search_sources + read_folder_file',
        observation: `{"content":"${'EGTS v1.0 '.repeat(80)}"}`,
      }),
      step({ thought: sameThought, action: 'reason', observation: 'draft 1' }),
      step({ thought: sameThought, action: 'reason', observation: 'draft 2' }),
      step({ thought: sameThought, action: 'reason', observation: 'draft 3' }),
    ];
    expect(await detectLoop(steps)).toBeNull();
  });

  it('skips loop detection when web_search already returned results', async () => {
    const same = 'Нужно сформулировать сводку новостей по СВО для пользователя';
    const webObs = JSON.stringify({
      query: 'СВО',
      results: Array.from({ length: 5 }, (_, i) => ({
        title: `News ${i}`,
        url: `https://example.com/${i}`,
        snippet: 'x'.repeat(80),
      })),
    });
    const steps: Step[] = [
      step({ thought: 'search', action: 'web_search', observation: webObs }),
      step({ thought: same, action: 'reason', observation: 'draft' }),
      step({ thought: same, action: 'reason', observation: 'draft2' }),
      step({ thought: same, action: 'reason', observation: 'draft3' }),
    ];
    expect(await detectLoop(steps)).toBeNull();
  });

  it('does not treat strategy_hint injections as pattern loops', async () => {
    const steps: Step[] = [
      step({ action: 'strategy_hint', input: {}, observation: 'hint A — go use tools now please' }),
      step({ action: 'strategy_hint', input: {}, observation: 'hint B — go use tools now please' }),
      step({ action: 'strategy_hint', input: {}, observation: 'hint C — go use tools now please' }),
    ];
    expect(await detectLoop(steps)).toBeNull();
  });
});
