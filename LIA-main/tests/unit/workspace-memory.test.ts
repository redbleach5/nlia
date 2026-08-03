import { describe, expect, it } from 'vitest';
import {
  workspaceFingerprint,
  workspaceMemoryKey,
  isWorkspaceMemoryFactKey,
  formatWorkspaceMemoryForPrompt,
  parseFingerprintFromKey,
  filterOutWorkspaceMemoryFacts,
} from '@/lib/agent/workspace-memory';
import { normalizeWorkspaceInput } from '@/lib/agent/workspace-types';

describe('workspace-memory', () => {
  it('fingerprints project path stably (case/slash insensitive)', () => {
    const a = normalizeWorkspaceInput({
      kind: 'project',
      fsPath: 'C:\\Users\\Me\\Proj',
      label: 'Proj',
    });
    const b = normalizeWorkspaceInput({
      kind: 'project',
      fsPath: 'C:/Users/Me/Proj',
      label: 'Proj',
    });
    expect(workspaceFingerprint(a)).toBe(workspaceFingerprint(b));
    expect(workspaceFingerprint(a)).toMatch(/^p_[a-f0-9]{12}$/);
  });

  it('fingerprints kb by sorted source ids', () => {
    const a = normalizeWorkspaceInput({
      kind: 'kb',
      sourceIds: ['b', 'a'],
      label: 'Docs',
    });
    const b = normalizeWorkspaceInput({
      kind: 'kb',
      sourceIds: ['a', 'b'],
      label: 'Docs',
    });
    expect(workspaceFingerprint(a)).toBe(workspaceFingerprint(b));
    expect(workspaceFingerprint(a)).toMatch(/^k_[a-f0-9]{12}$/);
  });

  it('returns null fingerprint without identity', () => {
    expect(workspaceFingerprint(null)).toBeNull();
    expect(workspaceFingerprint(normalizeWorkspaceInput({
      kind: 'kb',
      sourceIds: [],
      label: 'Empty',
    }))).toBeNull();
  });

  it('builds and parses memory keys', () => {
    const key = workspaceMemoryKey('p_abc123def456', 'overview');
    expect(key).toBe('workspace.p_abc123def456.overview');
    expect(isWorkspaceMemoryFactKey(key)).toBe(true);
    expect(parseFingerprintFromKey(key)).toBe('p_abc123def456');
    expect(isWorkspaceMemoryFactKey('user.name')).toBe(false);
  });

  it('formats prompt with limit', () => {
    const block = formatWorkspaceMemoryForPrompt([
      { key: 'workspace.p_x.label', shortKey: 'label', value: 'MyProj' },
      { key: 'workspace.p_x.overview', shortKey: 'overview', value: 'Корень: src/, docs/' },
    ]);
    expect(block).toContain('Что ты помнишь об этом workspace');
    expect(block).toContain('label: MyProj');
    expect(block).toContain('overview:');
  });

  it('filters workspace facts from profile list', () => {
    const filtered = filterOutWorkspaceMemoryFacts([
      { key: 'user.name', value: 'Ann' },
      { key: 'workspace.p_x.label', value: 'X' },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].key).toBe('user.name');
  });
});
