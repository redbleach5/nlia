import 'server-only';

// ============================================================================
// Project probe — detect docs vs code files under a path (for unified "Add project").
// ============================================================================

import { readdirSync, type Dirent } from 'fs';
import path from 'path';
import { resolveFolderPath, shouldSkipKbFile } from './folder-utils';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  '__pycache__',
  'dist',
  'build',
  '.venv',
  'venv',
  '.turbo',
  'coverage',
]);

const DOC_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.pdf', '.docx',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py',
]);

/** Soft cap so probe stays snappy on huge trees (Downloads, monorepos). */
const MAX_FILES_SCANNED = 50_000;

export type ProjectIndexMode = 'docs' | 'code';

export type ProjectProbeResult = {
  path: string;
  docFiles: number;
  codeFiles: number;
  scannedFiles: number;
  truncated: boolean;
  suggestedModes: ProjectIndexMode[];
};

/**
 * Walk a directory and count document vs source files.
 * Uses the same skip dirs as folder/code indexers.
 */
export function probeProjectPath(inputPath: string, signal?: AbortSignal): ProjectProbeResult {
  const root = resolveFolderPath(inputPath);
  let docFiles = 0;
  let codeFiles = 0;
  let scannedFiles = 0;
  let truncated = false;

  function walk(currentDir: string): void {
    if (truncated) return;
    if (signal?.aborted) throw new Error('aborted');

    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (signal?.aborted) throw new Error('aborted');

      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldSkipKbFile(entry.name)) continue;

      scannedFiles += 1;
      if (scannedFiles > MAX_FILES_SCANNED) {
        truncated = true;
        return;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (DOC_EXTENSIONS.has(ext)) docFiles += 1;
      else if (CODE_EXTENSIONS.has(ext)) codeFiles += 1;
    }
  }

  walk(root);

  const suggestedModes: ProjectIndexMode[] = [];
  if (docFiles > 0) suggestedModes.push('docs');
  if (codeFiles > 0) suggestedModes.push('code');

  return {
    path: root,
    docFiles,
    codeFiles,
    scannedFiles,
    truncated,
    suggestedModes,
  };
}

/**
 * Resolve which modes to create given user intent + probe.
 * Returns empty array if nothing can be created.
 */
export function resolveProjectModes(
  mode: 'auto' | 'docs' | 'code' | 'both',
  probe: ProjectProbeResult,
): { modes: ProjectIndexMode[]; warnings: string[] } {
  const warnings: string[] = [];
  const hasDocs = probe.docFiles > 0;
  const hasCode = probe.codeFiles > 0;

  if (mode === 'auto') {
    return { modes: [...probe.suggestedModes], warnings };
  }

  if (mode === 'docs') {
    if (!hasDocs) {
      warnings.push('В папке нет документов (.md, .txt, .pdf, .docx) — источник документов не создан.');
      return { modes: [], warnings };
    }
    return { modes: ['docs'], warnings };
  }

  if (mode === 'code') {
    if (!hasCode) {
      warnings.push('В папке нет исходников (.ts/.js/.py) — кодовая база не создана.');
      return { modes: [], warnings };
    }
    return { modes: ['code'], warnings };
  }

  // both
  const modes: ProjectIndexMode[] = [];
  if (hasDocs) modes.push('docs');
  else warnings.push('Документов нет — создана только кодовая база.');
  if (hasCode) modes.push('code');
  else warnings.push('Исходников нет — создан только каталог документов.');
  return { modes, warnings };
}
