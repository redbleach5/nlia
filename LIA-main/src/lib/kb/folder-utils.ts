import 'server-only';

import { existsSync, statSync, readdirSync, type Dirent } from 'fs';
import { realpathSync } from 'fs';
import path from 'path';
import type { FolderSourceConfig } from './types';

/** Расширения, поддерживаемые KB indexer. */
const KB_SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

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

/** Office/Windows temp files — не индексировать (lock-файлы Word, системный мусор). */
export function shouldSkipKbFile(filename: string): boolean {
  const base = path.basename(filename);
  const lower = base.toLowerCase();
  if (base.startsWith('~$')) return true;
  if (lower === 'thumbs.db' || lower === 'desktop.ini') return true;
  if (lower.endsWith('.tmp') || lower.endsWith('.temp')) return true;
  return false;
}

/** Мягкий лимит для предупреждения в UI (не блокирует manifest-индексацию). */
const FOLDER_FILE_WARN_THRESHOLD = 2000;

export function folderFileCountHint(fileCount: number): string | null {
  if (fileCount > FOLDER_FILE_WARN_THRESHOLD) {
    return `В папке ${fileCount} файлов — будет создан каталог имён (быстро). Содержимое читается по запросу.`;
  }
  if (fileCount > 200) {
    return `${fileCount} файлов — индексируются только имена; текст подгружается при поиске.`;
  }
  return null;
}

export interface FolderFileEntry {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
}

/**
 * Проверить и нормализовать путь к папке (realpath, must be directory).
 */
export function resolveFolderPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error('Укажите путь к папке');
  }

  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`Папка не найдена: ${resolved}`);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error('Указанный путь — не папка');
  }

  return realpathSync.native(resolved);
}

/**
 * Рекурсивно собрать поддерживаемые файлы в папке.
 */
export function collectFolderFiles(
  folderPath: string,
  signal?: AbortSignal,
): FolderFileEntry[] {
  const root = resolveFolderPath(folderPath);
  const results: FolderFileEntry[] = [];

  function walk(currentDir: string): void {
    if (signal?.aborted) throw new Error('aborted');

    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('aborted');

      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldSkipKbFile(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const mimeType = KB_SUPPORTED_EXTENSIONS[ext];
      if (!mimeType) continue;

      results.push({
        absolutePath: abs,
        relativePath: path.relative(root, abs).split(path.sep).join('/'),
        mimeType,
      });
    }
  }

  walk(root);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export function countSupportedFiles(folderPath: string): number {
  try {
    return collectFolderFiles(folderPath).length;
  } catch {
    return 0;
  }
}

/** Legacy .doc (не .docx) — не парсятся, но показываем пользователю подсказку. */
export function countLegacyDocFiles(folderPath: string): number {
  try {
    const root = resolveFolderPath(folderPath);
    let count = 0;
    const walk = (dir: string) => {
      let entries: import('fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          walk(abs);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.doc') && !entry.name.toLowerCase().endsWith('.docx')) {
          count++;
        }
      }
    };
    walk(root);
    return count;
  } catch {
    return 0;
  }
}

export function isPathUnderFolder(folderPath: string, filePath: string): boolean {
  const root = resolveFolderPath(folderPath);
  const resolved = normalizePathForScopeCheck(filePath);
  const relative = path.relative(root, resolved);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Align /var vs /private/var (macOS) so path.relative works after realpath on folder. */
function normalizePathForScopeCheck(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    if (existsSync(resolved)) {
      return realpathSync.native(resolved);
    }
    const parent = path.dirname(resolved);
    if (existsSync(parent)) {
      return path.join(realpathSync.native(parent), path.basename(resolved));
    }
  } catch { /* keep resolved */ }
  return resolved;
}

/**
 * Stricter variant of isPathUnderFolder: resolves symlinks via realpath
 * before checking. Slower (sync FS call) but safer — used by tests and
 * security-critical code paths.
 *
 * Falls back to isPathUnderFolder (no realpath) if realpath fails (e.g.
 * target file does not exist yet).
 */
export function isPathInsideFolder(folderPath: string, filePath: string): boolean {
  try {
    const root = resolveFolderPath(folderPath);
    const resolvedFile = realpathSync.native(path.resolve(filePath));
    return isPathUnderFolder(root, resolvedFile);
  } catch {
    return isPathUnderFolder(folderPath, filePath);
  }
}

export function buildFolderConfig(folderPath: string, fileCount: number): FolderSourceConfig {
  return {
    folderPath: resolveFolderPath(folderPath),
    fileCount,
    // Watcher на больших папках (Downloads) вешает dev-сервер — включается вручную.
    watchEnabled: false,
  };
}
