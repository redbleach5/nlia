import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { probeProjectPath, resolveProjectModes } from '@/lib/kb/project-probe';
import { createKbProjectSchema, validateKbProjectSchema } from '@/lib/infra/api-validation';

describe('probeProjectPath', () => {
  it('counts docs and code files and suggests modes', () => {
    const dir = path.join(os.tmpdir(), `lia-probe-${Date.now()}`);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    try {
      writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const x = 1;\n');
      writeFileSync(path.join(dir, 'docs', 'readme.md'), '# hi\n');
      writeFileSync(path.join(dir, 'notes.txt'), 'plain\n');
      // ignored
      mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports=1\n');

      const probe = probeProjectPath(dir);
      expect(probe.docFiles).toBe(2);
      expect(probe.codeFiles).toBe(1);
      expect(probe.suggestedModes).toEqual(['docs', 'code']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suggests only code when no docs', () => {
    const dir = path.join(os.tmpdir(), `lia-probe-code-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
      const probe = probeProjectPath(dir);
      expect(probe.suggestedModes).toEqual(['code']);
      expect(resolveProjectModes('auto', probe).modes).toEqual(['code']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectModes', () => {
  const base = {
    path: '/tmp/x',
    docFiles: 3,
    codeFiles: 2,
    scannedFiles: 5,
    truncated: false,
    suggestedModes: ['docs', 'code'] as const,
  };

  it('both with missing side yields warning and partial modes', () => {
    const probe = { ...base, docFiles: 0, suggestedModes: ['code'] as ('docs' | 'code')[] };
    const { modes, warnings } = resolveProjectModes('both', probe);
    expect(modes).toEqual(['code']);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('docs mode refuses when no docs', () => {
    const probe = { ...base, docFiles: 0, suggestedModes: ['code'] as ('docs' | 'code')[] };
    const { modes } = resolveProjectModes('docs', probe);
    expect(modes).toEqual([]);
  });
});

describe('createKbProjectSchema', () => {
  it('accepts auto mode with path', () => {
    const r = createKbProjectSchema.safeParse({ path: '/tmp/proj', mode: 'auto' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mode).toBe('auto');
      expect(r.data.watchEnabled).toBe(true);
    }
  });

  it('rejects empty path', () => {
    expect(createKbProjectSchema.safeParse({ path: '' }).success).toBe(false);
  });
});

describe('validateKbProjectSchema', () => {
  it('requires path', () => {
    expect(validateKbProjectSchema.safeParse({ path: '/a' }).success).toBe(true);
    expect(validateKbProjectSchema.safeParse({}).success).toBe(false);
  });
});
