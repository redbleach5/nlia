// Unit tests for src/lib/kb/code-parser.ts

import { describe, it, expect } from 'vitest';
import { detectLanguage, parseCodeFile, sha256 } from '@/lib/kb/code-parser';

describe('code-parser', () => {
  it('detectLanguage maps extensions', () => {
    expect(detectLanguage('src/lib/agent/runner.ts')).toBe('typescript');
    expect(detectLanguage('app/page.tsx')).toBe('typescript');
    expect(detectLanguage('utils/helper.js')).toBe('javascript');
    expect(detectLanguage('scripts/kb-export.mjs')).toBe('javascript');
    expect(detectLanguage('tools/helper.py')).toBe('python');
    expect(detectLanguage('README.md')).toBeNull();
  });

  it('sha256 is deterministic', () => {
    const h1 = sha256('hello');
    const h2 = sha256('hello');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('parseCodeFile extracts exported TypeScript function', () => {
    const content = [
      '/** Runs the agent loop. */',
      'export async function runAgentTask(id: string): Promise<void> {',
      '  console.log(id);',
      '}',
    ].join('\n');

    const parsed = parseCodeFile('src/lib/agent/runner.ts', content);
    expect(parsed).not.toBeNull();
    expect(parsed!.language).toBe('typescript');
    expect(parsed!.symbols.some(s => s.name === 'runAgentTask' && s.type === 'function')).toBe(true);
    expect(parsed!.symbols.find(s => s.name === 'runAgentTask')?.isExported).toBe(true);
    expect(parsed!.fileImports).toEqual([]);
  });

  it('parseCodeFile extracts Python class and method', () => {
    const content = [
      'class Trainer:',
      '    """PPO trainer."""',
      '    def train(self, epochs: int) -> None:',
      '        pass',
    ].join('\n');

    const parsed = parseCodeFile('rl/train.py', content);
    expect(parsed).not.toBeNull();
    expect(parsed!.language).toBe('python');
    expect(parsed!.symbols.some(s => s.name === 'Trainer' && s.type === 'class')).toBe(true);
    expect(parsed!.symbols.some(s => s.name === 'train' && s.type === 'method')).toBe(true);
  });

  it('parseCodeFile returns null for unsupported extension', () => {
    expect(parseCodeFile('notes.txt', 'plain text')).toBeNull();
  });

  it('parseCodeFile returns null for empty content', () => {
    expect(parseCodeFile('empty.ts', '   \n  ')).toBeNull();
  });
});
