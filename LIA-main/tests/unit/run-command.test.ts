import { describe, it, expect } from 'vitest';
import {
  validateRunCommand,
  scrubCommandEnv,
  RUN_COMMAND_ALLOWED,
  GIT_ALLOWED_SUBCOMMANDS,
} from '@/lib/agent/tools/run-command';
import { isDangerousPackageCommand } from '@/lib/agent/command-sanitize';

describe('run_command validation', () => {
  it('allows bun/npm/git from allowlist', () => {
    expect(validateRunCommand('bun', ['run', 'test:ci'])).toEqual({
      ok: true,
      command: 'bun',
      args: ['run', 'test:ci'],
    });
    expect(validateRunCommand('git', ['status', '--short']).ok).toBe(true);
    expect(validateRunCommand('npm', ['test']).ok).toBe(true);
  });

  it('rejects unknown binaries and path forms', () => {
    expect(validateRunCommand('bash', ['-c', 'ls']).ok).toBe(false);
    expect(validateRunCommand('curl', ['https://evil']).ok).toBe(false);
    expect(validateRunCommand('/bin/sh', ['-c', 'id']).ok).toBe(false);
    expect(validateRunCommand('..\\git', ['status']).ok).toBe(false);
  });

  it('blocks shell metacharacters and npm -- forwarding', () => {
    expect(validateRunCommand('bun', ['test', '&&', 'rm', '-rf', '/']).ok).toBe(false);
    expect(validateRunCommand('npm', ['run', 'build', '--', '--evil']).ok).toBe(false);
  });

  it('blocks dangerous git verbs/flags', () => {
    expect(validateRunCommand('git', ['clean', '-fd']).ok).toBe(false);
    expect(validateRunCommand('git', ['push', '--force', 'origin', 'main']).ok).toBe(false);
    expect(validateRunCommand('git', ['push', '-f', 'origin', 'main']).ok).toBe(false);
    expect(validateRunCommand('git', ['reset', '--hard', 'HEAD~1']).ok).toBe(false);
    expect(validateRunCommand('git', ['config', '--global', 'user.name', 'x']).ok).toBe(false);
    expect(validateRunCommand('git', ['filter-branch']).ok).toBe(false);
  });

  it('allows common safe git workflow', () => {
    for (const args of [
      ['status'],
      ['diff', '--stat'],
      ['log', '-5', '--oneline'],
      ['add', 'src/lib/foo.ts'],
      ['commit', '-m', 'fix: something'],
      ['checkout', '-b', 'feature/x'],
    ]) {
      expect(validateRunCommand('git', args).ok, args.join(' ')).toBe(true);
    }
  });

  it('exports non-empty allowlists', () => {
    expect(RUN_COMMAND_ALLOWED.has('bun')).toBe(true);
    expect(GIT_ALLOWED_SUBCOMMANDS.has('status')).toBe(true);
  });

  it('marks package install as dangerous but not bun run test', () => {
    expect(isDangerousPackageCommand('npm', ['install', 'left-pad'])).toBe(true);
    expect(isDangerousPackageCommand('bun', ['run', 'test:ci'])).toBe(false);
  });

  it('executes node -e inside fsScope', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { setTaskApplyMode } = await import('@/lib/agent/file-changes');
    const dir = await mkdtemp(join(tmpdir(), 'lia-run-cmd-'));
    try {
      setTaskApplyMode('t', 'auto');
      const { makeRunCommandTool } = await import('@/lib/agent/tools/run-command');
      const t = makeRunCommandTool({ id: 't', fsScope: dir } as any);
      const result = await t.execute!(
        { command: 'node', args: ['-e', 'process.stdout.write("ok")'], cwd: '.', timeoutMs: 10_000 },
        { toolCallId: 'x', messages: [] } as any,
      );
      expect(result).toMatchObject({ success: true, stdout: 'ok', exitCode: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scrubCommandEnv', () => {
  it('removes secrets and LIA_ keys but keeps PATH and DATABASE_URL', () => {
    const scrubbed = scrubCommandEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      DATABASE_URL: 'file:../db/custom.db',
      LIA_ENCRYPTION_KEY: 'secret',
      LIA_SIDECAR_API_KEY: 'secret',
      OPENAI_API_KEY: 'sk-x',
      GROQ_API_KEY: 'g',
      MY_TOKEN: 't',
      NODE_ENV: 'test',
    });
    expect(scrubbed.PATH).toBe('/usr/bin');
    expect(scrubbed.DATABASE_URL).toBe('file:../db/custom.db');
    expect(scrubbed.NODE_ENV).toBe('test');
    expect(scrubbed.LIA_ENCRYPTION_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.MY_TOKEN).toBeUndefined();
  });
});
