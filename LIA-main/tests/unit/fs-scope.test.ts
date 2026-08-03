import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { safePathWithinScope, safeWriteFile } from '@/lib/agent/fs-scope';

describe('safePathWithinScope', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'lia-fs-scope-'));
    await writeFile(join(scopeDir, 'inside.txt'), 'hello', 'utf8');
    await mkdir(join(scopeDir, 'nested'), { recursive: true });
    await writeFile(join(scopeDir, 'nested', 'child.txt'), 'child', 'utf8');
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('returns null when scope is null', async () => {
    expect(await safePathWithinScope('foo.txt', null)).toBeNull();
  });

  it('allows relative path inside scope', async () => {
    const resolved = await safePathWithinScope('inside.txt', scopeDir);
    expect(resolved).toBeTruthy();
    const content = await readFile(resolved!, 'utf8');
    expect(content).toBe('hello');
  });

  it('allows nested relative path', async () => {
    const resolved = await safePathWithinScope('nested/child.txt', scopeDir);
    expect(resolved).toBeTruthy();
  });

  it('blocks path traversal with ..', async () => {
    expect(await safePathWithinScope('../outside.txt', scopeDir)).toBeNull();
    expect(await safePathWithinScope('nested/../../outside.txt', scopeDir)).toBeNull();
  });

  it('blocks symlink pointing outside scope', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'lia-fs-outside-'));
    try {
      // На Windows создание symlink'ов может требовать прав.
      // Для теста используем junction (часто создаётся без админ-доступа),
      // чтобы всё равно проверить, что realpath(junction) не выходит за scope.
      if (process.platform === 'win32') {
        const outsideSecretDir = join(outsideDir, 'secret-dir');
        await mkdir(outsideSecretDir, { recursive: true });
        await writeFile(join(outsideSecretDir, 'secret.txt'), 'secret', 'utf8');

        try {
          await symlink(outsideSecretDir, join(scopeDir, 'escape-link'), 'junction');
          expect(await safePathWithinScope('escape-link', scopeDir)).toBeNull();
        } catch (e) {
          const err = e as { code?: string; message?: string };
          // Если even junction недоступен — пропускаем тест на этой машине.
          if (err.code === 'EPERM') return;
          throw e;
        }
      } else {
        await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
        await symlink(join(outsideDir, 'secret.txt'), join(scopeDir, 'escape-link.txt'));
        expect(await safePathWithinScope('escape-link.txt', scopeDir)).toBeNull();
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows write path for new file when parent directory exists in scope', async () => {
    const resolved = await safePathWithinScope('nested/new-file.txt', scopeDir);
    expect(resolved).toBeTruthy();
    expect(resolved).toContain('nested');
  });

  // P-CORE-4 regression: previously safePathWithinScope returned null when
  // the immediate parent directory didn't exist (realpath threw ENOENT).
  // This blocked the common agent workflow of creating files in not-yet-
  // existing subdirectories like `src/new_module/file.ts`.
  it('P-CORE-4: allows write path when neither target nor parent exists yet', async () => {
    const resolved = await safePathWithinScope('src/new_module/file.ts', scopeDir);
    expect(resolved).toBeTruthy();
    expect(resolved).toContain('src');
    expect(resolved).toContain('new_module');
  });

  it('P-CORE-4: allows deeply nested write path with no existing ancestors', async () => {
    const resolved = await safePathWithinScope('a/b/c/d/file.txt', scopeDir);
    expect(resolved).toBeTruthy();
  });

  it('P-CORE-4: still blocks traversal even when intermediate dirs dont exist', async () => {
    expect(await safePathWithinScope('new/../../escape.txt', scopeDir)).toBeNull();
    expect(await safePathWithinScope('../new/file.txt', scopeDir)).toBeNull();
  });
});

describe('safeWriteFile', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'lia-fs-write-'));
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('writes file inside scope', async () => {
    await mkdir(join(scopeDir, 'out'), { recursive: true });
    await safeWriteFile('out/file.txt', scopeDir, 'written by safeWriteFile');
    const content = await readFile(join(scopeDir, 'out', 'file.txt'), 'utf8');
    expect(content).toBe('written by safeWriteFile');
  });

  it('throws when path escapes scope', async () => {
    await expect(safeWriteFile('../escape.txt', scopeDir, 'nope')).rejects.toThrow(/outside scope/i);
  });

  it('overwrites existing file in scope', async () => {
    await writeFile(join(scopeDir, 'existing.txt'), 'old', 'utf8');
    await safeWriteFile('existing.txt', scopeDir, 'new');
    expect(await readFile(join(scopeDir, 'existing.txt'), 'utf8')).toBe('new');
  });

  // P-CORE-4 regression: safeWriteFile should create intermediate directories
  // that don't exist yet, so the agent can write `src/new_module/file.ts`
  // without first calling a separate mkdir tool (which doesn't exist).
  it('P-CORE-4: creates intermediate directories for nested new file', async () => {
    await safeWriteFile('src/new_module/file.ts', scopeDir, 'export const x = 1;');
    const content = await readFile(join(scopeDir, 'src', 'new_module', 'file.ts'), 'utf8');
    expect(content).toBe('export const x = 1;');
  });

  it('P-CORE-4: creates deeply nested path with no existing ancestors', async () => {
    await safeWriteFile('a/b/c/d/file.txt', scopeDir, 'deep');
    const content = await readFile(join(scopeDir, 'a', 'b', 'c', 'd', 'file.txt'), 'utf8');
    expect(content).toBe('deep');
  });
});
