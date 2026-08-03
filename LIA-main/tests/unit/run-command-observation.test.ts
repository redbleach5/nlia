import { describe, it, expect } from 'vitest';
import {
  formatRunCommandObservation,
  formatToolObservation,
  OBSERVATION_CAP_CMD,
} from '@/lib/agent/runner-helpers';

describe('formatRunCommandObservation', () => {
  it('formats success as a readable terminal dump', () => {
    const text = formatRunCommandObservation({
      command: 'git',
      args: ['status', '--short'],
      cwd: '.',
      exitCode: 0,
      stdout: ' M src/a.ts\n',
      stderr: '',
      durationMs: 42,
      success: true,
    });
    expect(text).toContain('$ git status --short');
    expect(text).toContain('exit=0');
    expect(text).toContain('--- stdout ---');
    expect(text).toContain('M src/a.ts');
    expect(text).not.toContain('"command"');
  });

  it('includes stderr and non-zero exit', () => {
    const text = formatRunCommandObservation({
      command: 'bun',
      args: ['run', 'test:ci'],
      cwd: '.',
      exitCode: 1,
      stdout: 'ok\n',
      stderr: 'FAIL tests/x.test.ts\n',
      durationMs: 900,
      success: false,
    });
    expect(text).toContain('exit=1');
    expect(text).toContain('--- stderr ---');
    expect(text).toContain('FAIL tests/x.test.ts');
  });

  it('surfaces validation errors without pretending a command ran', () => {
    const text = formatRunCommandObservation({
      error: 'command "rm" not allowed',
      success: false,
    });
    expect(text).toContain('run_command error');
    expect(text).toContain('not allowed');
  });

  it('respects CMD observation cap', () => {
    const huge = 'line\n'.repeat(OBSERVATION_CAP_CMD);
    const text = formatRunCommandObservation({
      command: 'pytest',
      args: [],
      cwd: '.',
      exitCode: 0,
      stdout: huge,
      stderr: '',
      success: true,
    });
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('truncated');
  });
});

describe('formatToolObservation', () => {
  it('still JSON-stringifies generic objects', () => {
    expect(formatToolObservation({ ok: true, n: 1 })).toBe('{"ok":true,"n":1}');
  });
});
