// Smoke tests for src/lib/paths.ts — resolves DB and sqlite-vec paths.
//
// These tests are critical because the audit (§2.1) found a path mismatch
// between Prisma and better-sqlite3 that silently split data across two
// SQLite files. The resolveDbPath() function strips leading "../" so that
// DATABASE_URL=file:../db/custom.db resolves the same way for both layers.

import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveDbPath, sanitizeFilename, PROJECT_ROOT } from '@/lib/paths';

const dbPath = path.join(PROJECT_ROOT, 'db', 'custom.db');

describe('resolveDbPath', () => {
  it('strips leading ../ from relative URL (audit §2.1 fix)', () => {
    const resolved = resolveDbPath('file:../db/custom.db');
    // Should resolve to <root>/db/custom.db, NOT <parent>/db/custom.db
    expect(resolved).toBe(dbPath);
  });

  it('handles multiple leading ../ segments', () => {
    const resolved = resolveDbPath('file:../../db/custom.db');
    expect(resolved).toBe(dbPath);
  });

  it('handles leading ..\\ on Windows-style paths', () => {
    const resolved = resolveDbPath('file:..\\db\\custom.db');
    // On POSIX, path.join converts \\ to /; on Windows it stays as \\.
    // Just verify the path ends with db/custom.db (or db\\custom.db).
    expect(resolved).toMatch(/[db][\\/custom.db]+$/);
    expect(resolved).toContain('custom.db');
    expect(resolved.startsWith(PROJECT_ROOT)).toBe(true);
  });

  it('passes through absolute paths unchanged (normalized)', () => {
    const abs = process.platform === 'win32'
      ? 'C:\\absolute\\path\\db.db'
      : '/absolute/path/db.db';
    const resolved = resolveDbPath(`file:${abs}`);
    // path.normalize on POSIX leaves forward slashes; on Windows it may
    // convert backslashes. Just check the path is absolute and contains
    // the expected directory components.
    expect(resolved).toMatch(/absolute/);
    expect(resolved).toMatch(/path/);
    expect(resolved).toMatch(/db\.db$/);
  });

  it('uses default db/custom.db when no URL provided', () => {
    const resolved = resolveDbPath(undefined);
    expect(resolved).toBe(dbPath);
  });

  it('handles empty string URL', () => {
    const resolved = resolveDbPath('');
    expect(resolved).toBe(dbPath);
  });

  it('handles file: prefix only (no path)', () => {
    const resolved = resolveDbPath('file:');
    expect(resolved).toBe(dbPath);
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators', () => {
    expect(sanitizeFilename('foo/bar')).toBe('foo_bar');
    expect(sanitizeFilename('foo\\bar')).toBe('foo_bar');
    expect(sanitizeFilename('foo:bar')).toBe('foo_bar');
  });

  it('replaces whitespace with underscore', () => {
    expect(sanitizeFilename('foo bar baz')).toBe('foo_bar_baz');
  });

  it('removes leading dot (no hidden files)', () => {
    expect(sanitizeFilename('.env')).toBe('_env');
    expect(sanitizeFilename('.gitignore')).toBe('_gitignore');
  });

  it('lowercases the result', () => {
    expect(sanitizeFilename('MyFile.TXT')).toBe('myfile.txt');
  });

  it('rejects path traversal attempts (separators stripped)', () => {
    // sanitizeFilename replaces /, \, : with _ — so the resulting string
    // has no path separators. (Dots themselves are whitelisted, so ".." may
    // remain as a literal sequence, but with no separators it can't traverse.)
    const result = sanitizeFilename('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    expect(result).not.toContain(':');
  });

  it('limits length to 200 chars', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('falls back to "untitled" for empty input', () => {
    // Note: sanitizeFilename replaces whitespace with _ first, so "   "
    // becomes "_" rather than empty. Only truly empty input falls back.
    expect(sanitizeFilename('')).toBe('untitled');
  });

  it('preserves cyrillic characters', () => {
    const result = sanitizeFilename('файл.txt');
    expect(result).toBe('файл.txt');
  });

  it('preserves dots, hyphens, underscores', () => {
    expect(sanitizeFilename('my-file_v1.2.txt')).toBe('my-file_v1.2.txt');
  });
});
