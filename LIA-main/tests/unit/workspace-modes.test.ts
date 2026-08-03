import { describe, expect, it } from 'vitest';
import {
  inferWorkspaceMode,
  resolveWorkspaceMode,
  applyModeWhitelist,
  needsSandboxConfirm,
  modeAllowsWriteSandbox,
  READ_TOOLS,
  EXPLORE_TOOLS,
  EDIT_TOOLS,
} from '@/lib/agent/workspace-modes';

describe('workspace-modes', () => {
  it('infers read for KB lookup', () => {
    expect(inferWorkspaceMode('Найди описание поля EGTS в базе знаний')).toBe('read');
    expect(inferWorkspaceMode('Что такое протокол в документе?')).toBe('read');
  });

  it('infers explore for code review', () => {
    expect(inferWorkspaceMode('Изучи проект и найди проблемы')).toBe('explore');
    expect(inferWorkspaceMode('Где вызывается resolveWorkspace?')).toBe('explore');
  });

  it('infers edit for fix/implement', () => {
    expect(inferWorkspaceMode('Исправь баг в runner.ts')).toBe('edit');
    expect(inferWorkspaceMode('Реализуй функцию parseWorkspace')).toBe('edit');
  });

  it('manual override beats auto', () => {
    expect(resolveWorkspaceMode('Исправь баг', 'read')).toBe('read');
    expect(resolveWorkspaceMode('Найди в базе', 'edit')).toBe('edit');
    expect(resolveWorkspaceMode('что угодно', 'auto')).toBe(inferWorkspaceMode('что угодно'));
  });

  it('read whitelist has no write/run tools', () => {
    const tools = applyModeWhitelist('read');
    expect(tools).toEqual(expect.arrayContaining([...READ_TOOLS]));
    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('edit_file');
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('code_run');
  });

  it('explore has read FS but no write', () => {
    const tools = applyModeWhitelist('explore');
    expect(tools).toEqual(expect.arrayContaining(['grep', 'read_file', 'search_codebase']));
    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('run_command');
  });

  it('edit includes write tools', () => {
    const tools = applyModeWhitelist('edit');
    expect(tools).toEqual(expect.arrayContaining([
      'write_file',
      'edit_file',
      'run_command',
      'propose_design',
      'runtime_start',
      'runtime_logs',
      'runtime_stop',
    ]));
    expect(tools.length).toBeGreaterThanOrEqual(EDIT_TOOLS.length);
  });

  it('intersects caller whitelist with mode', () => {
    const tools = applyModeWhitelist('edit', {
      callerWhitelist: ['write_file', 'web_search', 'not_a_tool'],
    });
    expect(tools).toEqual(['write_file', 'web_search']);
  });

  it('intersects template whitelist with mode', () => {
    const tools = applyModeWhitelist('explore', {
      templateWhitelist: ['search_sources', 'write_file', 'grep'],
    });
    expect(tools).toContain('search_sources');
    expect(tools).toContain('grep');
    expect(tools).not.toContain('write_file');
  });

  it('needsSandboxConfirm only for edit+sandbox without confirm', () => {
    expect(needsSandboxConfirm('edit', 'sandbox', false)).toBe(true);
    expect(needsSandboxConfirm('edit', 'sandbox', true)).toBe(false);
    expect(needsSandboxConfirm('edit', 'explicit', false)).toBe(false);
    expect(needsSandboxConfirm('explore', 'sandbox', false)).toBe(false);
    expect(needsSandboxConfirm('edit', 'sandbox', false, { intentionalSandboxBinding: true })).toBe(false);
    expect(needsSandboxConfirm('edit', 'sandbox', false, { fsScopeAlreadyBound: true })).toBe(false);
  });

  it('modeAllowsWriteSandbox only for edit', () => {
    expect(modeAllowsWriteSandbox('edit')).toBe(true);
    expect(modeAllowsWriteSandbox('read')).toBe(false);
    expect(modeAllowsWriteSandbox('explore')).toBe(false);
  });

  it('explore tools are a superset of read', () => {
    for (const t of READ_TOOLS) {
      expect(EXPLORE_TOOLS).toContain(t);
    }
  });
});
