import 'server-only';

// ============================================================================
// KB Tools — agent tools для работы с Knowledge Base.
// ============================================================================
//
// Три tool'а добавляются в buildAgentTools():
//   - search_sources  — гибридный поиск по всем источникам (vector + BM25 + RRF)
//   - get_source      — полный источник целиком (все chunks одного source)
//   - list_sources    — список всех источников в KB
//
// Все tools возвращают результат в формате, удобном для LLM:
//   - Содержит citation для inline-упоминания в ответе
//   - Content truncation для search_sources (1500 chars) — больше полей/таблиц в hit
//   - get_source: optional focusQuery → релевантные chunks + соседи (не head-truncate всего doc)
//
// Read-only для Лии: Лия читает KB, но не пишет. Write только через UI/API.

import { tool } from 'ai';
import { z } from 'zod';
import { searchKB } from './search';
import { hydrateKbSearchHits, readFolderFileContent } from './folder-read';
import { resolveKbSourceId } from './kb-source-id';
import { formatSearchSourcesChunk } from './search-hit-format';
import { selectChunksByFocusQuery } from './chunk-focus';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { ChunkMetadata, FolderSourceConfig } from './types';

// ============================================================================
// search_sources — гибридный поиск
// ============================================================================

export function makeSearchSourcesTool(opts?: {
  /** Hard-filter to these Source.id when non-empty (episode workspace pin). */
  pinnedSourceIds?: string[];
}) {
  const pinned = (opts?.pinnedSourceIds ?? []).filter(Boolean).slice(0, 5);
  const pinHint = pinned.length > 0
    ? `\nСейчас активен pin workspace (${pinned.length} источник(ов)). Поиск ограничен ими, `
      + `если не передан searchEverywhere=true.`
    : '';

  return tool({
    description: `Семантический поиск по базе знаний (документы, папки, URL, codebase).
Используй когда:
- Вопрос касается загруженных документов, папок или codebase в KB
- Нужно найти информацию в проектной документации
- Пользователь упоминает раздел документа или файл в папке
${pinHint}
В каждом чанке: chunkId (id чанка), sourceId (id источника для get_source),
relativePath (для folder — путь к файлу для read_folder_file).
НЕ передавай chunkId в get_source — только sourceId.

Возвращает чанки с citations — обязательно укажи источник в ответе,
используя формат [citation] (например, [API Reference > Глава 1]).`,
    inputSchema: z.object({
      query: z.string().min(1).describe('Что искать в базе знаний'),
      sourceTypes: z.array(z.enum(['document', 'folder', 'url', 'codebase'])).optional()
        .describe('Ограничить типы источников (по умолчанию — все)'),
      limit: z.number().int().min(1).max(50).default(10)
        .describe('Максимум результатов (по умолчанию 10)'),
      searchEverywhere: z.boolean().optional()
        .describe('true = игнорировать pin workspace и искать по всей KB'),
    }),
    execute: async ({ query, sourceTypes, limit, searchEverywhere }) => {
      try {
        const sourceIds = searchEverywhere || pinned.length === 0 ? undefined : pinned;
        const rawResults = await searchKB({ query, sourceTypes, limit, sourceIds });
        const results = await hydrateKbSearchHits(rawResults, query, 3);

        if (results.length === 0) {
          return {
            chunks: [],
            totalCount: 0,
            pinned: !!sourceIds,
            message: sourceIds
              ? 'Ничего не найдено в привязанных источниках workspace. Попробуй searchEverywhere=true или уточни запрос.'
              : 'Ничего не найдено в базе знаний. Если информация должна быть — предложи пользователю загрузить документ через Настройки → База знаний.',
          };
        }

        return {
          chunks: results.map(r => formatSearchSourcesChunk(r)),
          totalCount: results.length,
          pinned: !!sourceIds,
        };
      } catch (e) {
        logger.error('kb', 'search_sources tool failed', { query: query.slice(0, 60) }, e);
        return { error: 'search failed', chunks: [], totalCount: 0 };
      }
    },
  });
}

// ============================================================================
// get_source — получить все chunks одного source
// ============================================================================

export function makeGetSourceTool(opts?: { goalHint?: string }) {
  return tool({
    description: `Получить контент источника из базы знаний.
Используй когда:
- search_sources вернул интересный chunk и нужно больше контекста / соседние разделы
- Нужны поля, таблицы, подробная структура (передай focusQuery!)
- Пользователь просит показать документ целиком

focusQuery — ключевые термины из задачи (например "EGTS_SR_ADAS_DATA 245").
Без focusQuery на больших документах вернутся только первые chunks (мало полезного).

Для folder (manifest): chunks — каталог; полный текст — read_folder_file.`,
    inputSchema: z.object({
      sourceId: z.string().min(1)
        .describe('Source.id из search_sources (поле sourceId). Если передан chunkId — будет разрешён автоматически'),
      focusQuery: z.string().min(1).optional()
        .describe('Ключевые термины для выбора релевантных chunks (рекомендуется для больших документов)'),
    }),
    execute: async ({ sourceId: sourceOrChunkId, focusQuery }) => {
      try {
        const resolvedSourceId = await resolveKbSourceId(sourceOrChunkId);
        if (!resolvedSourceId) {
          return {
            error: 'source not found',
            hint: 'Используй sourceId из search_sources (не chunkId). Для folder — read_folder_file(sourceId, relativePath).',
          };
        }

        if (resolvedSourceId !== sourceOrChunkId) {
          logger.debug('kb', 'get_source resolved chunk id to source id', {
            chunkId: sourceOrChunkId.slice(0, 8),
            sourceId: resolvedSourceId.slice(0, 8),
          });
        }

        const sourceId = resolvedSourceId;

        const source = await db.source.findUnique({
          where: { id: sourceId },
          select: { id: true, name: true, type: true, chunkCount: true, status: true, config: true },
        });

        if (!source) {
          return { error: 'source not found' };
        }

        if (source.status !== 'ready') {
          return {
            error: `source is not ready (status: ${source.status})`,
            source: { id: source.id, name: source.name, type: source.type, status: source.status },
          };
        }

        const chunks = await db.chunk.findMany({
          where: { sourceId },
          orderBy: { position: 'asc' },
          select: {
            id: true,
            content: true,
            metadata: true,
            position: true,
            parentId: true,
          },
        });

        let folderHint: string | undefined;
        if (source.type === 'folder') {
          try {
            const cfg = JSON.parse(source.config) as FolderSourceConfig;
            if (cfg.indexMode === 'manifest') {
              folderHint =
                'Папка в режиме manifest: для текста файла вызови read_folder_file с sourceId и relativePath из search_sources.';
            }
          } catch { /* ignore */ }
        }

        const mapped = chunks.map(c => {
          let metadata: ChunkMetadata;
          try {
            metadata = JSON.parse(c.metadata) as ChunkMetadata;
          } catch {
            metadata = { isComment: false } as ChunkMetadata;
          }
          return {
            id: c.id,
            content: c.content,
            metadata,
            position: c.position,
            parentId: c.parentId,
          };
        });

        const effectiveFocus = focusQuery?.trim() || opts?.goalHint?.trim() || undefined;

        const { selected, mode, dropped } = selectChunksByFocusQuery(mapped, effectiveFocus, {
          maxChunks: 18,
          neighborRadius: 1,
        });

        return {
          source: {
            id: source.id,
            name: source.name,
            type: source.type,
            chunkCount: source.chunkCount,
          },
          ...(folderHint ? { hint: folderHint } : {}),
          mode,
          ...(mode === 'focused' ? {
            focusQuery: effectiveFocus,
            selectedCount: selected.length,
            droppedCount: dropped,
            hintExtra: dropped > 0
              ? 'Показаны релевантные chunks по focusQuery. Уточни focusQuery или вызови снова с другими терминами для других разделов.'
              : undefined,
          } : {}),
          chunks: selected,
          totalCount: chunks.length,
        };
      } catch (e) {
        logger.error('kb', 'get_source tool failed', { sourceId: sourceOrChunkId.slice(0, 8) }, e);
        return { error: 'failed to fetch source' };
      }
    },
  });
}

// ============================================================================
// read_folder_file — прочитать файл из folder source с диска
// ============================================================================

export function makeReadFolderFileTool() {
  return tool({
    description: `Прочитать содержимое конкретного файла из folder source в базе знаний.
Используй когда:
- search_sources нашёл файл по имени (manifest), но нужен полный или другой фрагмент текста
- Пользователь указал конкретный файл в папке
- get_source для folder source вернул только каталог имён

relativePath — поле relativePath из search_sources (путь к файлу относительно корня folder source). Не chunkId и не служебные ярлыки режима индексации.`,
    inputSchema: z.object({
      sourceId: z.string().min(1)
        .describe('sourceId из search_sources (folder source). chunkId тоже будет разрешён'),
      relativePath: z.string().min(1)
        .describe('relativePath из hit search_sources — реальный путь файла в папке'),
      maxChars: z.number().int().min(500).max(20000).optional()
        .describe('Максимум символов (по умолчанию 12000)'),
    }),
    execute: async ({ sourceId: sourceOrChunkId, relativePath, maxChars }) => {
      try {
        const resolvedSourceId = await resolveKbSourceId(sourceOrChunkId);
        if (!resolvedSourceId) {
          return {
            error: 'source not found',
            hint: 'Передай sourceId и relativePath из результата search_sources.',
          };
        }

        const file = await readFolderFileContent({
          sourceId: resolvedSourceId,
          relativePath,
          maxChars,
        });
        return {
          sourceId: resolvedSourceId,
          relativePath: file.relativePath,
          sourceName: file.sourceName,
          citation: `${file.sourceName} > ${file.relativePath}`,
          content: file.content,
          truncated: file.truncated,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : 'read failed';
        logger.error('kb', 'read_folder_file tool failed', {
          sourceId: sourceOrChunkId.slice(0, 8),
          relativePath,
        }, e);
        return { error: message };
      }
    },
  });
}

// ============================================================================
// list_sources — список всех источников
// ============================================================================

export function makeListSourcesTool() {
  return tool({
    description: `Список всех источников в базе знаний (документы, папки, URL, codebase).
Используй когда:
- Нужно показать пользователю что проиндексировано
- Пользователь спрашивает "что ты знаешь?" — покажи список источников
- Перед вызовом search_sources или get_source нужно узнать sourceId

Возвращает массив источников с id, name, type, status, chunkCount.`,
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const sources = await db.source.findMany({
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            chunkCount: true,
            lastIndexedAt: true,
            errorMessage: true,
          },
          orderBy: { updatedAt: 'desc' },
        });

        return {
          sources: sources.map(s => ({
            id: s.id,
            name: s.name,
            type: s.type,
            status: s.status,
            chunkCount: s.chunkCount,
            lastIndexedAt: s.lastIndexedAt?.toISOString() ?? null,
            hasError: !!s.errorMessage,
          })),
          totalCount: sources.length,
        };
      } catch (e) {
        logger.error('kb', 'list_sources tool failed', {}, e);
        return { error: 'failed to list sources', sources: [], totalCount: 0 };
      }
    },
  });
}
