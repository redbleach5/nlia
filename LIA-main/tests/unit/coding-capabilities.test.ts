import { describe, it, expect } from 'vitest';
import { formatFileChangesDigest } from '@/lib/agent/step-history-compact';
import { normalizeTargetFiles, buildCodingIntentFromPlan } from '@/lib/agent/coding-intent';
import { buildClaudeCodeUserPrompt } from '@/lib/agent/claude-code/prompt';

describe('file changes digest', () => {
  it('formats compact digest', () => {
    const d = formatFileChangesDigest([
      { path: 'a.tsx', tool: 'write_file', status: 'applied' },
      { path: 'b.ts', tool: 'edit_file', status: 'pending' },
    ]);
    expect(d).toContain('a.tsx');
    expect(d).toContain('edit b.ts');
  });

  it('returns empty for no changes', () => {
    expect(formatFileChangesDigest([])).toBe('');
  });
});

describe('coding intent + CC prompt', () => {
  it('builds intent with targetFiles', () => {
    const intent = buildCodingIntentFromPlan({
      goal: 'x',
      steps: ['a'],
      complexity: 'high',
      targetFiles: ['src/a.ts', '../evil'],
    });
    expect(intent.targetFiles).toEqual(['src/a.ts']);
  });

  it('includes brief and planHint in CC prompt without companion markers', () => {
    const p = buildClaudeCodeUserPrompt({
      goal: 'Add page',
      fsScope: '/tmp/proj',
      brief: 'Previous coding task…\nGoal: old',
      planHint: 'Lia plan:\n1. write page',
    });
    expect(p).toContain('Add page');
    expect(p).toContain('Previous coding');
    expect(p).toContain('Lia plan');
    expect(p.toLowerCase()).not.toContain('ты — лия');
  });
});

describe('normalizeTargetFiles', () => {
  it('drops escapes', () => {
    expect(normalizeTargetFiles(['ok.ts', '..\\x'])).toEqual(['ok.ts']);
  });
});
