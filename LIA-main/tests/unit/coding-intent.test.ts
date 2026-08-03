import { describe, it, expect } from 'vitest';
import {
  buildCodingIntentFromPlan,
  buildCodingTaskBrief,
  mergeTargetFiles,
  normalizeTargetFiles,
  formatCodingBriefForPrompt,
  fingerprintFromFsScope,
} from '@/lib/agent/coding-intent';

describe('coding-intent', () => {
  it('normalizes and caps target files', () => {
    expect(normalizeTargetFiles(['./a.ts', 'a.ts', '../x', '/abs', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
    expect(normalizeTargetFiles(Array.from({ length: 30 }, (_, i) => `f${i}.ts`)).length).toBe(20);
  });

  it('merges target files', () => {
    expect(mergeTargetFiles(['a.ts'], ['b.ts', 'a.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('builds intent from plan', () => {
    const intent = buildCodingIntentFromPlan({
      goal: 'Add page',
      steps: ['write page', 'wire route'],
      complexity: 'high',
      targetFiles: ['app/x/page.tsx'],
    }, { brief: 'Prior: done y' });
    expect(intent.targetFiles).toEqual(['app/x/page.tsx']);
    expect(intent.complexity).toBe('high');
    expect(intent.brief).toContain('Prior');
  });

  it('builds brief under cap', () => {
    const brief = buildCodingTaskBrief({
      goal: 'Add Button',
      summary: 'Created component and route',
      files: ['src/Button.tsx', 'src/routes.ts'],
    });
    expect(brief.length).toBeLessThanOrEqual(400);
    expect(brief).toContain('Button.tsx');
  });

  it('formats brief for prompt', () => {
    expect(formatCodingBriefForPrompt('Goal: x')).toContain('Previous coding');
    expect(formatCodingBriefForPrompt('  ')).toBe('');
  });

  it('fingerprints fsScope', () => {
    expect(fingerprintFromFsScope('/tmp/proj')).toMatch(/^p_/);
    expect(fingerprintFromFsScope('/x/agent-workspaces/ep')).toMatch(/^s_/);
    expect(fingerprintFromFsScope(null)).toBeNull();
  });
});
