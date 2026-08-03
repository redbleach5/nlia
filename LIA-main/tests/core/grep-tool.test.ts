import { describe, expect, it, beforeEach } from 'vitest';
import { PATHS } from '@/lib/paths';
import type { AgentTask } from '@/lib/agent/task';
import {
  makeGrepTool,
  compileGrepPattern,
  MAX_GREP_PATTERN_LEN,
  _resetRgCacheForTests,
  _setRgCacheForTests,
} from '@/lib/agent/tools/grep';

function fakeTask(fsScope: string | null): AgentTask {
  return {
    id: 'grep-test',
    episodeId: 'e1',
    goal: 'test',
    status: 'pending',
    planJson: null,
    stepsJson: '[]',
    currentStep: 0,
    maxSteps: 10,
    maxDurationSec: 60,
    resultSummary: null,
    error: null,
    toolsWhitelist: null,
    fsScope,
    checkpointJson: null,
    artifactsJson: '[]',
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentTask;
}

describe('compileGrepPattern (ReDoS)', () => {
  it('rejects oversized patterns', () => {
    const result = compileGrepPattern('a'.repeat(MAX_GREP_PATTERN_LEN + 1), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too long/i);
  });

  it('compiles nested quantifiers via RE2 without hanging', () => {
    const started = Date.now();
    const result = compileGrepPattern('(a+)+b', false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Classic ReDoS input: many a's then a non-matching char — V8 RegExp hangs.
    const line = `${'a'.repeat(40)}c`;
    expect(result.match(line)).toBe(false);
    expect(result.match(`${'a'.repeat(10)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.engine).toBe('re2');
  });

  it('matches simple symbols', () => {
    const result = compileGrepPattern('makeGrepTool', false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match('export function makeGrepTool(')).toBe(true);
    expect(result.match('something else')).toBe(false);
  });
});

describe('grep tool', () => {
  beforeEach(() => {
    _resetRgCacheForTests();
  });

  it('denies without fsScope', async () => {
    const tool = makeGrepTool(fakeTask(null));
    const result = await tool.execute!(
      { pattern: 'runAgentTask', path: '', maxResults: 5, caseInsensitive: false, extension: '' },
      { toolCallId: 't1', messages: [], abortSignal: AbortSignal.timeout(10_000), context: {} },
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/запрещ/i) });
  });

  it('finds symbols via Node engine within path', async () => {
    _setRgCacheForTests(null); // force Node walk
    const tool = makeGrepTool(fakeTask(PATHS.root));
    const result = await tool.execute!(
      {
        pattern: 'makeGrepTool',
        path: 'src/lib/agent',
        maxResults: 10,
        caseInsensitive: false,
        extension: 'ts',
      },
      { toolCallId: 't2', messages: [], abortSignal: AbortSignal.timeout(30_000), context: {} },
    ) as {
      engine?: string;
      count?: number;
      hits?: Array<{ path: string; line: number }>;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.engine).toBe('node');
    expect((result.count ?? 0) > 0).toBe(true);
    expect(result.hits!.some((h) => h.path.includes('grep.ts'))).toBe(true);
  });

  it('Node engine survives ReDoS-shaped pattern quickly', async () => {
    _setRgCacheForTests(null);
    const tool = makeGrepTool(fakeTask(PATHS.root));
    const started = Date.now();
    const result = await tool.execute!(
      {
        pattern: '(a+)+$',
        path: 'src/lib/agent/tools',
        maxResults: 5,
        caseInsensitive: false,
        extension: 'ts',
      },
      { toolCallId: 't3', messages: [], abortSignal: AbortSignal.timeout(15_000), context: {} },
    ) as { error?: string; engine?: string };
    expect(result.error).toBeUndefined();
    expect(result.engine).toBe('node');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
