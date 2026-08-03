import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// На Win32 обычно доступен `python`, а не `python3`.
const PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python' : 'python3';

/**
 * P4-1: code-run AST validator unit tests.
 * Tests the Python AST validator directly (not the full code_run tool).
 * Verifies P0-2 fix (C-SEC-4): white-list approach blocks sys/types/gc/weakref.
 */

// We need to import the validator string from code-run.ts.
// Since it's a const string, we replicate the validator call here.
// In production, code-run.ts writes user code to a temp file and calls:
//   python3 -c <PYTHON_AST_VALIDATOR> <code_path>
// We do the same for testing.

// Windows cold-starts of `python -c <large validator>` often exceed 5s on the
// first few invocations in CI; later calls are fast. Keep Linux tight, give
// Win room, and warm the interpreter once before the suite.
const AST_VALIDATE_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 5_000;

async function validateCode(code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Import the validator string from code-run.ts
    const mod = await import('@/lib/tools/code-run');
    const validator = mod.PYTHON_AST_VALIDATOR;

    if (!validator || typeof validator !== 'string' || validator.length < 100) {
      return {
        ok: false,
        error: `PYTHON_AST_VALIDATOR invalid: type=${typeof validator}, length=${validator?.length ?? 0}, keys=${Object.keys(mod).join(',')}`,
      };
    }

    const astDir = join(tmpdir(), `lia-ast-test-${randomUUID()}`);
    await mkdir(astDir, { recursive: true });
    const codePath = join(astDir, 'user_code.py');
    try {
      await writeFile(codePath, code, 'utf8');
      const result = await execFileAsync(PYTHON_EXECUTABLE, ['-c', validator, codePath], {
        timeout: AST_VALIDATE_TIMEOUT_MS,
        maxBuffer: 10_000,
      });
      return JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string };
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      return { ok: false, error: `python unavailable: ${err.stderr || err.message || 'unknown'}` };
    } finally {
      try { await rm(astDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (outerErr) {
    return { ok: false, error: `validateCode failed: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}` };
  }
}

describe('code-run: AST validator (white-list approach)', () => {
  // Warm the Windows Python cold-start once so the first real cases don't
  // burn the whole 5–30s budget on interpreter launch.
  beforeAll(async () => {
    await validateCode('x = 1');
  }, AST_VALIDATE_TIMEOUT_MS + 5_000);

  describe('allows safe modules', () => {
    const safeModules = [
      'math', 'json', 're', 'itertools', 'collections', 'functools',
      'datetime', 'time', 'random', 'string', 'base64', 'hashlib',
      'copy', 'uuid', 'csv', 'operator', 'statistics', 'fractions',
    ];

    for (const mod of safeModules) {
      it(`allows import ${mod}`, async () => {
        const result = await validateCode(`import ${mod}`);
        expect(result.ok, result.error).toBe(true);
      });
    }

    it('allows from-import', async () => {
      const result = await validateCode('from math import sqrt, pi');
      expect(result.ok).toBe(true);
    });

    it('allows basic arithmetic', async () => {
      const result = await validateCode('x = 2 + 2\nprint(x)');
      expect(result.ok).toBe(true);
    });

    it('allows list comprehensions', async () => {
      const result = await validateCode('squares = [x**2 for x in range(10)]');
      expect(result.ok).toBe(true);
    });
  });

  describe('blocks sandbox escape vectors (P0-2 fix, C-SEC-4)', () => {
    it('blocks import sys (sys.modules[os] escape)', async () => {
      const result = await validateCode('import sys');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('sys');
    });

    it('blocks import types (synthesize modules)', async () => {
      const result = await validateCode('import types');
      expect(result.ok).toBe(false);
    });

    it('blocks import gc (heap walking)', async () => {
      const result = await validateCode('import gc');
      expect(result.ok).toBe(false);
    });

    it('blocks import weakref', async () => {
      const result = await validateCode('import weakref');
      expect(result.ok).toBe(false);
    });

    it('blocks import platform (host info leak)', async () => {
      const result = await validateCode('import platform');
      expect(result.ok).toBe(false);
    });

    it('blocks import threading', async () => {
      const result = await validateCode('import threading');
      expect(result.ok).toBe(false);
    });

    it('blocks import inspect (getsource reads files)', async () => {
      const result = await validateCode('import inspect');
      expect(result.ok).toBe(false);
    });

    it('blocks import traceback (reads source files)', async () => {
      const result = await validateCode('import traceback');
      expect(result.ok).toBe(false);
    });

    it('blocks the actual escape: import sys; sys.modules["os"].system(...)', async () => {
      const result = await validateCode('import sys\nsys.modules["os"].system("id")');
      expect(result.ok).toBe(false);
    });
  });

  describe('blocks dangerous calls', () => {
    it('blocks eval()', async () => {
      const result = await validateCode("eval(\"__import__('os').system('id')\")");
      expect(result.ok).toBe(false);
    });

    it('blocks exec()', async () => {
      const result = await validateCode('exec("import os")');
      expect(result.ok).toBe(false);
    });

    it('blocks __import__()', async () => {
      const result = await validateCode("__import__('os').system('id')");
      expect(result.ok).toBe(false);
    });

    it('blocks getattr (reflection bypass)', async () => {
      const result = await validateCode('getattr(obj, "system")("id")');
      expect(result.ok).toBe(false);
    });

    it('blocks open() (file read)', async () => {
      const result = await validateCode('open("/etc/passwd").read()');
      expect(result.ok).toBe(false);
    });
  });

  describe('blocks dangerous attributes', () => {
    it('blocks __subclasses__ (classic escape)', async () => {
      const result = await validateCode('x = ().__class__.__bases__[0].__subclasses__()');
      expect(result.ok).toBe(false);
    });

    it('blocks __globals__', async () => {
      const result = await validateCode('x = func.__globals__');
      expect(result.ok).toBe(false);
    });

    // Note: __builtins__ as a bare Name (not Attribute) is not blocked.
    // This is intentional — accessing __builtins__ returns a dict, but
    // executing arbitrary code requires further calls (eval/exec/__import__)
    // which ARE blocked. Blocking bare Names would break legitimate variable names.
  });

  describe('blocks FS/OS modules', () => {
    it('blocks import os', async () => {
      const result = await validateCode('import os');
      expect(result.ok).toBe(false);
    });

    it('blocks import subprocess', async () => {
      const result = await validateCode('import subprocess');
      expect(result.ok).toBe(false);
    });

    it('blocks import socket (network)', async () => {
      const result = await validateCode('import socket');
      expect(result.ok).toBe(false);
    });

    it('blocks import pickle (RCE via deserialization)', async () => {
      const result = await validateCode('import pickle');
      expect(result.ok).toBe(false);
    });

    it('blocks import pathlib', async () => {
      const result = await validateCode('import pathlib');
      expect(result.ok).toBe(false);
    });

    it('blocks from os import system', async () => {
      const result = await validateCode('from os import system');
      expect(result.ok).toBe(false);
    });
  });

  describe('rejects non-allow-listed modules (fail-closed)', () => {
    it('blocks import requests (in BLOCKED — network)', async () => {
      const result = await validateCode('import requests');
      expect(result.ok).toBe(false);
      // requests is in BLOCKED_MODULES (network), so blocked by block-list first
      expect(result.error).toContain('blocked');
    });

    it('blocks import numpy (not in allow-list, not in block-list)', async () => {
      const result = await validateCode('import numpy');
      expect(result.ok).toBe(false);
      // numpy is NOT in BLOCKED_MODULES, so should hit allow-list check
      expect(result.error).toContain('not in allow-list');
    });

    it('blocks import pandas (not in allow-list)', async () => {
      const result = await validateCode('import pandas');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not in allow-list');
    });
  });
});
