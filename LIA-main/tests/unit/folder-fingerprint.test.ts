import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import path from 'path';
import os from 'os';
import { folderFileFingerprint, buildManifestConfigUpdate } from '@/lib/kb/folder-manifest';
import type { FolderSourceConfig } from '@/lib/kb/types';
import type { FolderFileEntry } from '@/lib/kb/folder-utils';

describe('folderFileFingerprint', () => {
  it('is stable for unchanged file and changes when content+mtime change', () => {
    const dir = path.join(os.tmpdir(), `lia-fp-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'a.md');
    try {
      writeFileSync(file, 'hello');
      const a = folderFileFingerprint(file);
      const b = folderFileFingerprint(file);
      expect(a).toBe(b);
      expect(a).toHaveLength(16);

      const prev = a;
      writeFileSync(file, 'hello world changed');
      const future = new Date(Date.now() + 2000);
      utimesSync(file, future, future);
      const c = folderFileFingerprint(file);
      expect(c).not.toBe(prev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildManifestConfigUpdate stores fingerprints under fileHashes', () => {
    const dir = path.join(os.tmpdir(), `lia-fp-cfg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, 'note.txt');
    writeFileSync(abs, 'x');
    try {
      const files: FolderFileEntry[] = [{
        absolutePath: abs,
        relativePath: 'note.txt',
        mimeType: 'text/plain',
      }];
      const cfg = buildManifestConfigUpdate(
        { folderPath: dir } as FolderSourceConfig,
        files,
      );
      expect(cfg.indexMode).toBe('manifest');
      expect(cfg.fileHashes?.['note.txt']).toBe(folderFileFingerprint(abs));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
