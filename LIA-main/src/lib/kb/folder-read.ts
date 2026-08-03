import 'server-only';

import path from 'path';
import { existsSync } from 'fs';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseKbFile } from './indexer';
import { resolveFolderPath, isPathUnderFolder } from './folder-utils';
import { extractKbQueryKeywords } from './kb-query-filter';
import { isManifestChunk } from './folder-manifest';
import type { DocumentChunkMetadata, FolderSourceConfig, SearchResult } from './types';

const DEFAULT_MAX_CHARS = 12_000;

/**
 * Прочитать содержимое файла из folder source с диска (без предварительного embed).
 */
export async function readFolderFileContent(params: {
  sourceId: string;
  relativePath: string;
  maxChars?: number;
  queryHint?: string;
  signal?: AbortSignal;
}): Promise<{
  content: string;
  truncated: boolean;
  relativePath: string;
  sourceName: string;
}> {
  const { sourceId, relativePath, maxChars = DEFAULT_MAX_CHARS, queryHint, signal } = params;

  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: { name: true, type: true, config: true },
  });

  if (!source || source.type !== 'folder') {
    throw new Error('Источник не найден или не является папкой');
  }

  const config = JSON.parse(source.config) as FolderSourceConfig;
  const root = resolveFolderPath(config.folderPath);
  const normalized = relativePath.split('\\').join('/').replace(/^\.\/+/, '').trim();
  if (!normalized || normalized.includes('..')) {
    throw new Error('Некорректный relativePath');
  }

  const absolutePath = path.resolve(root, normalized);

  if (!isPathUnderFolder(root, absolutePath)) {
    throw new Error('Недопустимый путь к файлу');
  }

  if (!existsSync(absolutePath)) {
    throw new Error(
      `Файл не найден в папке источника: ${normalized}. ` +
      'Нужен relativePath из search_sources (путь к реальному файлу), не служебное слово.',
    );
  }

  const markdown = await parseKbFile(
    absolutePath,
    guessMime(normalized),
    signal ?? AbortSignal.timeout(120_000),
  );
  const excerpt = pickExcerpt(markdown, queryHint ?? '', maxChars);

  return {
    content: excerpt.text,
    truncated: excerpt.truncated,
    relativePath: normalized,
    sourceName: source.name,
  };
}

function guessMime(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.text': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] ?? 'text/plain';
}

function pickExcerpt(
  text: string,
  queryHint: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const keywords = extractKbQueryKeywords(queryHint);
  const lower = text.toLowerCase();

  for (const kw of keywords) {
    const idx = lower.indexOf(kw);
    if (idx >= 0) {
      const start = Math.max(0, idx - Math.floor(maxChars * 0.2));
      const slice = text.slice(start, start + maxChars);
      const prefix = start > 0 ? '…' : '';
      const suffix = start + maxChars < text.length ? '…' : '';
      return { text: prefix + slice + suffix, truncated: true };
    }
  }

  return { text: text.slice(0, maxChars) + '…', truncated: true };
}

/**
 * Подменить manifest-hits на реальное содержимое файлов с диска.
 */
export async function hydrateKbSearchHits(
  hits: SearchResult[],
  query: string,
  maxFiles = 3,
): Promise<SearchResult[]> {
  const result: SearchResult[] = [];
  let hydratedCount = 0;

  for (const hit of hits) {
    const meta = hit.metadata as DocumentChunkMetadata;

    if (!isManifestChunk(meta) || !meta.relativePath) {
      result.push(hit);
      continue;
    }

    // Уже прочитано probeFolderContentByQuery — не парсить DOCX повторно
    if (hit.matchType === 'folder_probe' && hit.content.length > 200) {
      result.push(hit);
      continue;
    }

    if (hydratedCount >= maxFiles) {
      result.push({
        ...hit,
        content: `${hit.content}\n\n(Содержимое не загружено — слишком много совпадений. Используй read_folder_file для конкретного файла.)`,
      });
      continue;
    }

    try {
      const file = await readFolderFileContent({
        sourceId: hit.sourceId,
        relativePath: meta.relativePath,
        queryHint: query,
      });

      hydratedCount++;
      result.push({
        ...hit,
        content: file.content,
        citation: `${file.sourceName} > ${file.relativePath}`,
        metadata: { ...meta, manifest: true },
      });
    } catch (e) {
      logger.warn('kb', 'Failed to hydrate manifest hit', {
        sourceId: hit.sourceId.slice(0, 8),
        relativePath: meta.relativePath,
      }, e);
      result.push(hit);
    }
  }

  return result;
}
