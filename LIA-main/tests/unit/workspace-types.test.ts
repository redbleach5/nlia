import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceBinding,
  serializeWorkspaceBinding,
  normalizeWorkspaceInput,
  formatWorkspaceForPrompt,
  pinnedSourceIds,
  MAX_PINNED_SOURCES,
  WORKSPACE_FACT_KEY,
} from '@/lib/agent/workspace-types';

describe('workspace-types', () => {
  it('exports stable fact key', () => {
    expect(WORKSPACE_FACT_KEY).toBe('lia.workspace');
  });

  it('parses and serializes round-trip', () => {
    const binding = normalizeWorkspaceInput({
      kind: 'kb',
      sourceIds: ['src1', 'src2'],
      label: 'Protocol',
      fsPath: null,
    });
    const raw = serializeWorkspaceBinding(binding);
    const parsed = parseWorkspaceBinding(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('kb');
    expect(parsed!.sourceIds).toEqual(['src1', 'src2']);
    expect(parsed!.label).toBe('Protocol');
    expect(parsed!.pinKb).toBe(true);
  });

  it('caps sourceIds at MAX_PINNED_SOURCES', () => {
    const ids = Array.from({ length: MAX_PINNED_SOURCES + 3 }, (_, i) => `s${i}`);
    const binding = normalizeWorkspaceInput({ kind: 'kb', sourceIds: ids, label: 'Many' });
    expect(binding.sourceIds).toHaveLength(MAX_PINNED_SOURCES);
  });

  it('returns null for empty / none / garbage', () => {
    expect(parseWorkspaceBinding('')).toBeNull();
    expect(parseWorkspaceBinding('{"kind":"none"}')).toBeNull();
    expect(parseWorkspaceBinding('not-json')).toBeNull();
  });

  it('pinnedSourceIds respects pinKb flag', () => {
    const on = normalizeWorkspaceInput({ kind: 'kb', sourceIds: ['a'], label: 'A' });
    expect(pinnedSourceIds(on)).toEqual(['a']);
    const off = { ...on, pinKb: false };
    expect(pinnedSourceIds(off)).toEqual([]);
  });

  it('formatWorkspaceForPrompt is nonempty for binding', () => {
    const binding = normalizeWorkspaceInput({
      kind: 'project',
      fsPath: 'C:/Users/me/project',
      label: 'project',
    });
    const line = formatWorkspaceForPrompt(binding);
    expect(line).toContain('Активный workspace');
    expect(line).toContain('project');
  });
});
