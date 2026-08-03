import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordFileChange,
  undoFileChange,
  undoAllFileChanges,
  getFileChange,
  clearFileChanges,
} from '@/lib/agent/file-changes';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('file-changes undo stack', () => {
  const taskId = 'task-file-change-test';
  let dir: string;

  beforeEach(async () => {
    clearFileChanges(taskId);
    dir = await mkdtemp(join(tmpdir(), 'lia-fc-'));
  });

  afterEach(async () => {
    clearFileChanges(taskId);
    await rm(dir, { recursive: true, force: true }).catch(() => null);
  });

  it('records change and restores previous content on undo', async () => {
    const rel = 'hello.txt';
    const full = join(dir, rel);
    await writeFile(full, 'old\n', 'utf8');

    const rec = recordFileChange({
      taskId,
      path: rel,
      tool: 'edit_file',
      previousContent: 'old\n',
      diff: '  1: old\n---\n+ 1: new',
    });
    expect(rec.canUndo).toBe(true);
    expect(getFileChange(taskId, rec.id)?.path).toBe(rel);

    await writeFile(full, 'new\n', 'utf8');
    const result = await undoFileChange(taskId, rec.id, dir);
    expect(result).toEqual({ ok: true, path: rel });
    expect(await readFile(full, 'utf8')).toBe('old\n');
    expect(getFileChange(taskId, rec.id)).toBeNull();
  });

  it('deletes created file on undo', async () => {
    const rel = 'created.txt';
    const full = join(dir, rel);
    await writeFile(full, 'fresh\n', 'utf8');

    const rec = recordFileChange({
      taskId,
      path: rel,
      tool: 'write_file',
      previousContent: null,
    });
    expect(rec.created).toBe(true);

    const result = await undoFileChange(taskId, rec.id, dir);
    expect(result.ok).toBe(true);
    await expect(access(full)).rejects.toBeTruthy();
  });

  it('disables undo when previous content is huge', () => {
    const huge = 'x'.repeat(250_000);
    const rec = recordFileChange({
      taskId,
      path: 'big.txt',
      tool: 'edit_file',
      previousContent: huge,
    });
    expect(rec.canUndo).toBe(false);
  });

  it('undoAll restores stacked edits LIFO on the same file', async () => {
    const rel = 'stack.txt';
    const full = join(dir, rel);
    await writeFile(full, 'v1\n', 'utf8');

    recordFileChange({
      taskId,
      path: rel,
      tool: 'edit_file',
      previousContent: 'v1\n',
    });
    await writeFile(full, 'v2\n', 'utf8');

    recordFileChange({
      taskId,
      path: rel,
      tool: 'edit_file',
      previousContent: 'v2\n',
    });
    await writeFile(full, 'v3\n', 'utf8');

    const result = await undoAllFileChanges(taskId, dir);
    expect(result.ok).toBe(true);
    expect(result.undone).toEqual([rel, rel]);
    expect(await readFile(full, 'utf8')).toBe('v1\n');
  });
});
