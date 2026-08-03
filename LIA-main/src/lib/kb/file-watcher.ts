import 'server-only';

// ============================================================================
// File watcher — auto-reindex при изменении файлов (uploads + folder sources).
// ============================================================================

import chokidar, { type FSWatcher } from 'chokidar';
import { realpathSync, promises as fs } from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { indexDocumentSource } from './indexer';
import { indexFolderSource } from './folder-indexer';
import { reindexCodebaseFile, removeCodebaseFile } from './code-indexer';
import { PATHS } from '@/lib/paths';
import { logger } from '@/lib/logger';
import { isPathUnderFolder } from './folder-utils';
import type { DocumentSourceConfig, FolderSourceConfig, CodebaseSourceConfig } from './types';

let watcher: FSWatcher | null = null;
const pendingReindex = new Map<string, NodeJS.Timeout>();
const pendingCodebaseReindex = new Map<string, NodeJS.Timeout>();
const watchedFolderPaths = new Set<string>();

const SUPPORTED_CODEBASE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py',
]);

const CHOKIDAR_OPTS = {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 200,
  },
  ignored: [
    /(^|[/\\])\../,
    '**/node_modules/**',
    '**/.git/**',
    '**/.next/**',
  ],
};

/**
 * Запустить file watcher: kb-uploads/ + все folder sources с watchEnabled.
 */
export async function startFileWatcher(): Promise<void> {
  if (watcher) {
    logger.debug('kb', 'File watcher already running, skipping');
    return;
  }

  const uploadDir = path.join(PATHS.artifacts, 'kb-uploads');
  const folderPaths = await loadWatchPaths();
  const paths = [uploadDir, ...folderPaths];

  try {
    watcher = chokidar.watch(paths, CHOKIDAR_OPTS);

    watcher.on('change', (filePath) => { handleFileChange(filePath); });
    watcher.on('add', (filePath) => { handleFileChange(filePath); });
    watcher.on('unlink', (filePath) => { handleFileChange(filePath); });
    watcher.on('error', (error) => {
      logger.warn('kb', 'File watcher error (non-fatal)', {}, error);
    });

    folderPaths.forEach(p => watchedFolderPaths.add(p));
    logger.info('kb', 'File watcher started', { paths: paths.length, folders: folderPaths.length });
  } catch (e) {
    logger.warn('kb', 'Failed to start file watcher (non-fatal)', {}, e);
  }
}

/**
 * Добавить новую folder source в watcher (после создания источника).
 */
export async function refreshFolderWatchPaths(): Promise<void> {
  const folderPaths = await loadWatchPaths();
  if (!watcher) {
    await startFileWatcher();
    return;
  }

  for (const folderPath of folderPaths) {
    if (watchedFolderPaths.has(folderPath)) continue;
    try {
      watcher.add(folderPath);
      watchedFolderPaths.add(folderPath);
      logger.info('kb', 'Added path to file watcher', { folderPath });
    } catch (e) {
      logger.warn('kb', 'Failed to add path to watcher', { folderPath }, e);
    }
  }
}

/**
 * P-CORE-21 fix: now async and awaits `watcher.close()`. Previously the close
 * was fire-and-forget — `watcher = null` ran immediately, and a subsequent
 * `startFileWatcher` would create a NEW chokidar watcher on the same paths
 * while the old one was still closing. On Windows this can exhaust file
 * handles after N HMR cycles; on Linux/macOS the old watcher's pending
 * callbacks may still fire and trigger spurious reindex schedules.
 *
 * Callers (server-startup.ts shutdown hook) MUST `await stopFileWatcher()`.
 */
export async function stopFileWatcher(): Promise<void> {
  if (watcher) {
    const w = watcher;
    watcher = null;
    watchedFolderPaths.clear();
    try {
      await w.close();
    } catch (e) {
      logger.warn('kb', 'File watcher close failed (non-fatal)', {}, e);
    }
    logger.info('kb', 'File watcher stopped');
  }
}

async function loadWatchPaths(): Promise<string[]> {
  const paths: string[] = [];
  // folder sources (existing)
  paths.push(...await loadFolderWatchPaths());
  // codebase sources (new — Direction A)
  paths.push(...await loadCodebaseWatchPaths());
  return paths;
}

async function loadCodebaseWatchPaths(): Promise<string[]> {
  try {
    const codebaseSources = await db.source.findMany({
      where: { type: 'codebase', status: { in: ['ready', 'error', 'idle'] } },
      select: { id: true, name: true, config: true },
    });
    const paths: string[] = [];
    for (const source of codebaseSources) {
      try {
        const cfg = JSON.parse(source.config) as CodebaseSourceConfig;
        if (cfg.watchEnabled === false) continue;
        if (!cfg.projectPath) continue;
        paths.push(cfg.projectPath);
      } catch {
        // skip malformed config
      }
    }
    return paths;
  } catch {
    // DB not ready yet — return empty
    return [];
  }
}

async function loadFolderWatchPaths(): Promise<string[]> {
  // Следим за folder sources с watchEnabled=true. Раньше было отключено
  // (возвращало []) из-за опасения что большие папки (Downloads) вешают
  // dev-сервер. Но для single-user local-first это осознанный компромисс:
  // пользователь сам выбирает какую папку добавить, и если добавил Downloads
  // — это его выбор. Auto-reindex через manifest (быстро, без embeddings).
  //
  // Limit: если папка содержит >10k файлов — chokidar может есть память
  // при initial scan. Mitigation: chokidar ignore patterns для типичных
  // тяжёлых директорий (node_modules, .git, build artifacts).
  try {
    const folderSources = await db.source.findMany({
      where: { type: 'folder', status: { in: ['ready', 'error', 'idle'] } },
      select: { id: true, name: true, config: true },
    });

    const paths: string[] = [];
    for (const source of folderSources) {
      try {
        const cfg = JSON.parse(source.config) as FolderSourceConfig;
        if (cfg.watchEnabled === false) continue;  // default true
        if (!cfg.folderPath) continue;
        paths.push(cfg.folderPath);
      } catch {
        // skip malformed config
      }
    }
    return paths;
  } catch {
    // DB not ready yet (fresh install) — return empty
    return [];
  }
}

async function handleFileChange(filePath: string): Promise<void> {
  try {
    let resolvedFile: string;
    try {
      resolvedFile = realpathSync.native(path.resolve(filePath));
    } catch {
      resolvedFile = path.resolve(filePath);
    }

    const documentSources = await db.source.findMany({
      where: { type: 'document' },
      select: { id: true, config: true, name: true },
    });

    for (const source of documentSources) {
      try {
        const cfg = JSON.parse(source.config) as DocumentSourceConfig;
        if (cfg.filePath === resolvedFile || cfg.filePath === filePath) {
          scheduleReindex(source.id, 'document', source.name, resolvedFile);
        }
      } catch {
        // skip
      }
    }

    const folderSources = await db.source.findMany({
      where: { type: 'folder' },
      select: { id: true, config: true, name: true },
    });

    for (const source of folderSources) {
      try {
        const cfg = JSON.parse(source.config) as FolderSourceConfig;
        if (cfg.watchEnabled === false) continue;
        if (isPathUnderFolder(cfg.folderPath, resolvedFile)) {
          scheduleReindex(source.id, 'folder', source.name, resolvedFile);
        }
      } catch {
        // skip
      }
    }

    // ── Codebase sources (Direction A) — incremental per-file reindex ──
    const codebaseSources = await db.source.findMany({
      where: { type: 'codebase' },
      select: { id: true, config: true, name: true },
    });

    for (const source of codebaseSources) {
      try {
        const cfg = JSON.parse(source.config) as CodebaseSourceConfig;
        if (cfg.watchEnabled === false) continue;
        if (!isPathUnderFolder(cfg.projectPath, resolvedFile)) continue;

        // Только поддерживаемые расширения — иначе пропускаем
        const ext = path.extname(resolvedFile).toLowerCase();
        if (!SUPPORTED_CODEBASE_EXTENSIONS.has(ext)) continue;

        const relativePath = path.relative(cfg.projectPath, resolvedFile).replace(/\\/g, '/');
        scheduleCodebaseFileReindex(source.id, source.name, relativePath, resolvedFile);
      } catch {
        // skip
      }
    }
  } catch (e) {
    logger.warn('kb', 'File watcher handleFileChange failed', { filePath }, e);
  }
}

function scheduleReindex(
  sourceId: string,
  type: 'document' | 'folder',
  name: string,
  filePath: string,
): void {
  const existing = pendingReindex.get(sourceId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingReindex.delete(sourceId);
    logger.info('kb', 'Auto-reindex triggered by file change', {
      sourceId: sourceId.slice(0, 8),
      type,
      name,
      filePath,
    });
    // Folder: только manifest (быстро). Полный embed — только вручную (?mode=full).
    const indexer = type === 'folder' ? indexFolderSource : indexDocumentSource;
    indexer(sourceId).catch((e) => {
      logger.error('kb', 'Auto-reindex failed', { sourceId: sourceId }, e);
    });
  }, type === 'folder' ? 5000 : 2000);

  pendingReindex.set(sourceId, timer);
}

// ── Codebase: per-file incremental reindex (не full source reindex) ──
// Для codebase не переиндексируем весь source при изменении одного файла —
// это слишком дорого. Вместо этого reindexCodebaseFile() обновляет только
// изменившийся файл. См. code-indexer.ts.
function scheduleCodebaseFileReindex(
  sourceId: string,
  name: string,
  relativePath: string,
  fullPath: string,
): void {
  // Ключ — sourceId + relativePath (разные файлы — независимые таймеры)
  const key = `${sourceId}:${relativePath}`;
  const existing = pendingCodebaseReindex.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingCodebaseReindex.delete(key);
    logger.info('kb', 'Auto-reindex codebase file', {
      sourceId: sourceId.slice(0, 8),
      name,
      relativePath,
    });

    // Если файл ещё существует — reindex, иначе — remove
    fs.access(fullPath, fs.constants.F_OK)
      .then(() => reindexCodebaseFile(sourceId, relativePath))
      .catch(() => removeCodebaseFile(sourceId, relativePath))
      .catch((e) => {
        logger.error('kb', 'Codebase file reindex failed', { sourceId, relativePath }, e);
      });
  }, 2000);

  pendingCodebaseReindex.set(key, timer);
}
