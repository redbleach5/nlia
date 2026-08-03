import { describe, it, expect } from 'vitest';
import { parseMentions, stripMentionTokens } from '@/lib/agent/mentions';
import { compressFileForContext, estimateCharsBudget } from '@/lib/agent/context-compress';
import {
  sanitizeCommandArgs,
  sanitizePackageManagerArgs,
  isDangerousPackageCommand,
} from '@/lib/agent/command-sanitize';
import {
  resolvePermissionTier,
  networkPolicyForTier,
  shellNeedsPermission,
} from '@/lib/agent/permission-tiers';

describe('parseMentions', () => {
  it('parses @file and line windows', () => {
    const m = parseMentions('fix @file:src/lib/agent/runner.ts#L10-40 please');
    expect(m).toEqual([
      { kind: 'file', path: 'src/lib/agent/runner.ts', lineStart: 10, lineEnd: 40 },
    ]);
  });

  it('parses @folder', () => {
    const m = parseMentions('look @folder:src/lib/agent');
    expect(m[0]).toMatchObject({ kind: 'folder', path: 'src/lib/agent' });
  });

  it('strips mention tokens', () => {
    expect(stripMentionTokens('see @file:a.ts now')).toBe('see now');
  });
});

describe('compressFileForContext', () => {
  it('returns full for small files', () => {
    const r = compressFileForContext('a.ts', 'const x = 1;\n');
    expect(r.mode).toBe('full');
    expect(r.truncated).toBe(false);
  });

  it('uses signatures for large files', () => {
    const body = Array.from({ length: 200 }, (_, i) => `export function f${i}() { return ${i}; }`).join('\n');
    const r = compressFileForContext('big.ts', body, { fullCap: 500, signatureCap: 800 });
    expect(r.truncated).toBe(true);
    expect(r.mode).toBe('signatures');
    expect(r.text).toContain('truncated');
  });

  it('respects budget', () => {
    const out = estimateCharsBudget(['aaaa', 'bbbb', 'cccc'], 10);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/truncated|exhausted/);
  });
});

describe('command sanitize', () => {
  it('blocks shell metacharacters', () => {
    expect(sanitizeCommandArgs(['test', '&&', 'rm']).ok).toBe(false);
    expect(sanitizeCommandArgs(['a|b']).ok).toBe(false);
    expect(sanitizeCommandArgs(['>out']).ok).toBe(false);
  });

  it('blocks package-manager arg forwarding after --', () => {
    expect(sanitizePackageManagerArgs('npm', ['run', 'build', '--', '--evil']).ok).toBe(false);
  });

  it('allows bun test', () => {
    expect(sanitizePackageManagerArgs('bun', ['test']).ok).toBe(true);
  });

  it('flags install/ci as dangerous, not run/test', () => {
    expect(isDangerousPackageCommand('npm', ['install', 'evil-pkg'])).toBe(true);
    expect(isDangerousPackageCommand('npm', ['i', 'evil-pkg'])).toBe(true);
    expect(isDangerousPackageCommand('bun', ['install'])).toBe(true);
    expect(isDangerousPackageCommand('bun', ['ci'])).toBe(true);
    expect(isDangerousPackageCommand('yarn', ['add', 'x'])).toBe(true);
    expect(isDangerousPackageCommand('pnpm', ['add', 'x'])).toBe(true);
    expect(isDangerousPackageCommand('npx', ['some-pkg'])).toBe(false);
    expect(isDangerousPackageCommand('bun', ['run', 'test:ci'])).toBe(false);
    expect(isDangerousPackageCommand('npm', ['test'])).toBe(false);
    expect(isDangerousPackageCommand('git', ['status'])).toBe(false);
  });
});

describe('permission tiers', () => {
  it('maps edit + ask/auto', () => {
    expect(resolvePermissionTier('edit', 'ask')).toBe('edit-ask');
    expect(resolvePermissionTier('edit', 'auto')).toBe('edit-auto');
    expect(shellNeedsPermission('edit-ask')).toBe(true);
    expect(shellNeedsPermission('edit-auto')).toBe(false);
  });

  it('limits network ports/methods', () => {
    const p = networkPolicyForTier('explore');
    expect(p.allowedMethods).toContain('GET');
    expect(p.allowedPorts).toEqual([80, 443]);
  });
});
