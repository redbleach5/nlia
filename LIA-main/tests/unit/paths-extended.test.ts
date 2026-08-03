import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '@/lib/paths';

/**
 * P4-1: paths.ts sanitizeFilename tests.
 * Verifies P3-4 fix: strip '..' sequences (path traversal prevention).
 */
describe('paths: sanitizeFilename', () => {
  it('preserves simple filename', () => {
    expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
  });

  it('lowercases', () => {
    expect(sanitizeFilename('Document.PDF')).toBe('document.pdf');
  });

  it('replaces path separators', () => {
    expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
    expect(sanitizeFilename('path\\to\\file.txt')).toBe('path_to_file.txt');
  });

  it('strips leading dot (hidden files)', () => {
    expect(sanitizeFilename('.env')).toBe('_env');
    expect(sanitizeFilename('.gitignore')).toBe('_gitignore');
  });

  it('P3-4 fix: strips .. sequences (path traversal)', () => {
    expect(sanitizeFilename('..secret')).toBe('_secret');
    // ../../etc/passwd → each .. becomes _, each / becomes _ → ___etc_passwd
    // (2 dots → 1 _, 2 slashes → 2 _ = 3 _ total before etc)
    expect(sanitizeFilename('../../etc/passwd')).toBe('____etc_passwd');
    expect(sanitizeFilename('..')).toBe('_');
    expect(sanitizeFilename('....')).toBe('_');
  });

  it('replaces whitespace', () => {
    expect(sanitizeFilename('my file.txt')).toBe('my_file.txt');
    expect(sanitizeFilename('my  file.txt')).toBe('my_file.txt');
  });

  it('preserves Cyrillic', () => {
    expect(sanitizeFilename('документ.pdf')).toBe('документ.pdf');
  });

  it('replaces non-whitelist chars', () => {
    expect(sanitizeFilename('file@name#.txt')).toBe('file_name_.txt');
    expect(sanitizeFilename('file$name.txt')).toBe('file_name.txt');
  });

  it('limits length to 200 chars', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeFilename(long);
    expect(result.length).toBe(200);
  });

  it('returns "untitled" for empty string', () => {
    expect(sanitizeFilename('')).toBe('untitled');
  });

  it('preserves dots and hyphens', () => {
    expect(sanitizeFilename('my-file.v2.txt')).toBe('my-file.v2.txt');
  });
});
