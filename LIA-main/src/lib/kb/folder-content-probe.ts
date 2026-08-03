import 'server-only';

import path from 'path';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { extractKbQueryKeywords, extractContentIdentifiers } from './kb-query-filter';
import { isManifestChunk } from './folder-manifest';
import { readFolderFileContent } from './folder-read';
import type { DocumentChunkMetadata, SearchResult } from './types';

const MAX_CANDIDATES = 8;
const MAX_RESULTS = 2;

/** Ключевые слова для отбора файлов-кандидатов по имени/пути. */
function filenameProbeKeywords(query: string): string[] {
  const kws = extractKbQueryKeywords(query).filter(kw =>
    !(kw.includes('_') && kw.length > 6),
  );

  for (const id of extractContentIdentifiers(query)) {
    for (const part of id.split('_')) {
      if (part.length >= 3) kws.push(part);
    }
  }

  return [...new Set(kws)];
}

export function scoreManifestPath(relativePath: string, query: string): number {
  const pathLower = relativePath.toLowerCase();
  let score = 0;

  for (const kw of filenameProbeKeywords(query)) {
    if (pathLower.includes(kw)) score += Math.min(kw.length, 12);
  }

  return score;
}

export function shouldProbeFolderContent(query: string, hits: SearchResult[]): boolean {
  const identifiers = extractContentIdentifiers(query);
  if (identifiers.length === 0) return false;

  const blob = hits.map(h => h.content.toLowerCase()).join('\n');
  if (identifiers.some(id => blob.includes(id))) return false;

  return true;
}

interface ManifestCandidate {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  relativePath: string;
  score: number;
}

/**
 * Manifest-модель: идентификатор в теле документа → читаем с диска файлы
 * с релевантным именем (напр. «Описание протокола EGTS 05_03_2026.docx»).
 */
export async function probeFolderContentByQuery(
  query: string,
  opts?: { limit?: number },
): Promise<SearchResult[]> {
  const identifiers = extractContentIdentifiers(query);
  if (identifiers.length === 0) return [];

  const limit = opts?.limit ?? MAX_RESULTS;

  const folderSources = await db.source.findMany({
    where: { type: 'folder', status: 'ready' },
    select: { id: true, name: true },
  });
  if (folderSources.length === 0) return [];

  const sourceIds = folderSources.map(s => s.id);
  const sourceNameById = new Map(folderSources.map(s => [s.id, s.name]));

  const chunks = await db.chunk.findMany({
    where: { sourceId: { in: sourceIds } },
    select: { id: true, sourceId: true, metadata: true, content: true },
  });

  const candidates: ManifestCandidate[] = [];
  for (const chunk of chunks) {
    let meta: DocumentChunkMetadata;
    try {
      meta = JSON.parse(chunk.metadata) as DocumentChunkMetadata;
    } catch {
      continue;
    }
    if (!isManifestChunk(meta) || !meta.relativePath) continue;

    const score = scoreManifestPath(meta.relativePath, query);
    if (score <= 0) continue;

    candidates.push({
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      sourceName: sourceNameById.get(chunk.sourceId) ?? 'folder',
      relativePath: meta.relativePath,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Один файл — один probe (дубликаты в подпапках)
  const seenBasenames = new Set<string>();
  const toProbe: ManifestCandidate[] = [];
  for (const cand of candidates) {
    const base = path.basename(cand.relativePath).toLowerCase();
    if (seenBasenames.has(base)) continue;
    seenBasenames.add(base);
    toProbe.push(cand);
    if (toProbe.length >= MAX_CANDIDATES) break;
  }

  if (toProbe.length === 0) {
    logger.debug('kb', 'Folder content probe: no filename candidates', {
      query: query.slice(0, 60),
      manifestChunks: chunks.length,
    });
    return [];
  }

  const results: SearchResult[] = [];

  for (const cand of toProbe) {
    if (results.length >= limit) break;

    try {
      const file = await readFolderFileContent({
        sourceId: cand.sourceId,
        relativePath: cand.relativePath,
        queryHint: query,
      });

      const lower = file.content.toLowerCase();
      const matched = identifiers.filter(id => lower.includes(id));
      if (matched.length === 0) continue;

      results.push({
        id: cand.chunkId,
        sourceId: cand.sourceId,
        content: file.content,
        metadata: {
          relativePath: cand.relativePath,
          path: cand.relativePath,
          manifest: true,
        },
        score: cand.score / 100 + matched.length * 0.5,
        matchType: 'folder_probe',
        sourceName: cand.sourceName,
        sourceType: 'folder',
        citation: `${cand.sourceName} > ${cand.relativePath}`,
      });

      logger.info('kb', 'Folder content probe hit', {
        relativePath: cand.relativePath,
        matchedIds: matched,
      });
    } catch (e) {
      logger.warn('kb', 'Folder content probe read failed', {
        relativePath: cand.relativePath,
      }, e);
    }
  }

  return results;
}
