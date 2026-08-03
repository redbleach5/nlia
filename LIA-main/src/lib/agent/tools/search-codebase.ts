import 'server-only';

// ============================================================================
// search_codebase tool — agent tool для поиска по кодовой базе.
// ============================================================================
//
// Это новый agent tool, который добавляется в buildAgentTools() (tools.ts).
// Использует существующую searchKB() (hybrid: vector + BM25 + RRF)
// с фильтром по sourceType: 'codebase'.
//
// Отличия от search_sources:
//   1. Фильтрует только по codebase sources (не документы/тикеты)
//   2. Дополнительные фильтры: language, symbolType, filePath
//   3. Возвращает structured metadata: filePath, symbolName, lineRange
//   4. Content truncation до 800 chars (больше, чем search_sources —
//      код часто требует больше контекста для понимания)
//
// Integration в tools.ts:
//   import { makeSearchCodebaseTool } from './tools/search-codebase';
//   // в buildAgentTools():
//   search_codebase: makeSearchCodebaseTool(task),
// ============================================================================

import { tool } from 'ai';
import { z } from 'zod';
import { resolve, basename } from 'path';
import { searchKB } from '@/lib/kb/search';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { AgentTask } from '../task';

type CodebaseSourceRow = { id: string; name: string; config: string };

/**
 * Prefer codebase sources that match the active workspace / goal name.
 * Avoids union-searching Lia + external repos when fsScope is one of them.
 */
export async function selectCodebaseSourcesForTask(opts: {
  goal?: string;
  fsScope?: string | null;
}): Promise<Array<{ id: string; name: string }>> {
  const all = await db.source.findMany({
    where: { type: 'codebase', status: 'ready' },
    select: { id: true, name: true, config: true },
  }) as CodebaseSourceRow[];

  if (all.length <= 1) {
    return all.map((s) => ({ id: s.id, name: s.name }));
  }

  const g = (opts.goal || '').toLowerCase();
  const byGoalName = all
    .filter((s) => {
      const n = (s.name || '').trim();
      return n.length >= 3 && g.includes(n.toLowerCase());
    })
    .sort((a, b) => b.name.length - a.name.length);
  if (byGoalName.length > 0) {
    return byGoalName.map((s) => ({ id: s.id, name: s.name }));
  }

  const scope = (opts.fsScope || '').trim();
  if (scope && !/agent-workspaces[/\\]/i.test(scope)) {
    let scopeResolved: string;
    try {
      scopeResolved = resolve(scope).toLowerCase();
    } catch {
      scopeResolved = '';
    }
    if (scopeResolved) {
      const byPath: CodebaseSourceRow[] = [];
      for (const s of all) {
        try {
          const cfg = JSON.parse(s.config || '{}') as {
            projectPath?: string;
            folderPath?: string;
          };
          const p = (cfg.projectPath || cfg.folderPath || '').trim();
          if (!p) continue;
          if (resolve(p).toLowerCase() === scopeResolved) byPath.push(s);
        } catch {
          /* skip */
        }
      }
      if (byPath.length > 0) {
        return byPath.map((s) => ({ id: s.id, name: s.name }));
      }
    }

    const base = basename(scope).toLowerCase();
    if (base.length >= 3) {
      const byBase = all.filter((s) => {
        const n = (s.name || '').toLowerCase();
        return n === base || n.includes(base) || base.includes(n);
      });
      if (byBase.length === 1) {
        return byBase.map((s) => ({ id: s.id, name: s.name }));
      }
    }
  }

  return all.map((s) => ({ id: s.id, name: s.name }));
}

// ============================================================================
// Tool definition
// ============================================================================

export function makeSearchCodebaseTool(task?: Pick<AgentTask, 'goal' | 'fsScope'>) {
  return tool({
    description: `Семантический поиск по кодовой базе проекта (исходный код, не документы).
Используй когда:
- Нужно найти где реализована функция/класс/метод
- Нужно понять структуру проекта — где находятся файлы, какие символы экспортируются
- Пользователь спрашивает "где у нас обрабатывается X" или "как работает Y"
- Перед refactor — найти все места использования символа
- Для bugfix — найти релевантный код по описанию проблемы

Возвращает чанки с метаданными: filePath, symbolName, symbolType, lineRange, language.
Content обрезан до 800 chars — если нужно полное тело, используй read_file с filePath.

Поддерживаемые языки: TypeScript, JavaScript, Python.
Поиск hybrid: vector (semantic) + BM25 (keyword) + RRF fusion.`,
    inputSchema: z.object({
      query: z.string().min(1).describe(
        `Что искать. Можно:
- Семантический запрос: "обработка отмены задачи"
- Имя символа: "authenticateUser"
- Regex не поддерживается — для точного поиска по строке используй grep`
      ),
      language: z.enum(['typescript', 'javascript', 'python']).optional().describe(
        'Фильтр по языку (по умолчанию — все)'
      ),
      symbolType: z.enum(['function', 'method', 'class', 'interface', 'type', 'file']).optional().describe(
        'Фильтр по типу символа (по умолчанию — все)'
      ),
      filePathContains: z.string().optional().describe(
        'Фильтр по части пути файла (case-insensitive substring). Например "src/" или "tests/"'
      ),
      limit: z.number().int().min(1).max(50).default(10).describe(
        'Максимум результатов (по умолчанию 10)'
      ),
    }),
    execute: async ({ query, language, symbolType, filePathContains, limit }) => {
      try {
        const codebaseSources = await selectCodebaseSourcesForTask({
          goal: task?.goal,
          fsScope: task?.fsScope,
        });

        if (codebaseSources.length === 0) {
          return {
            chunks: [],
            totalCount: 0,
            message: 'Нет подключённых кодовых баз. Попроси пользователя добавить проект через Настройки → База знаний → Добавить кодовую базу.',
          };
        }

        const sourceIds = codebaseSources.map(s => s.id);

        const rawResults = await searchKB({
          query,
          sourceTypes: ['codebase'],
          sourceIds,
          limit: limit * 3, // over-fetch для post-filtering
        });

        if (rawResults.length === 0) {
          return {
            chunks: [],
            totalCount: 0,
            message: `Ничего не найдено по запросу "${query}". Попробуй:
- Переформулировать запрос (семантический, не keyword)
- Указать имя символа напрямую
- Использовать grep для точного поиска по подстроке/символу`,
          };
        }

        const filtered = rawResults.filter(r => {
          const meta = r.metadata as unknown as {
            language?: string;
            symbolType?: string;
            filePath?: string;
          };

          if (!meta.filePath || !meta.language) return false;
          if (language && meta.language !== language) return false;
          if (symbolType && meta.symbolType !== symbolType) return false;
          if (filePathContains) {
            const fp = meta.filePath.toLowerCase();
            if (!fp.includes(filePathContains.toLowerCase())) return false;
          }
          return true;
        });

        const trimmed = filtered.slice(0, limit);

        const chunks = trimmed.map(r => {
          const meta = r.metadata as unknown as {
            filePath: string;
            language: string;
            symbolType: string;
            symbolName: string;
            isExported: boolean;
            lineStart: number;
            lineEnd: number;
            docstring?: string;
          };

          const content = r.content.length > 800
            ? r.content.slice(0, 800) + '…'
            : r.content;

          return {
            id: r.id,
            content,
            sourceId: r.sourceId,
            sourceName: r.sourceName,
            citation: r.citation,
            score: Math.round(r.score * 1000) / 1000,
            matchType: r.matchType,
            metadata: {
              filePath: meta.filePath,
              language: meta.language,
              symbolType: meta.symbolType,
              symbolName: meta.symbolName,
              isExported: meta.isExported,
              lineStart: meta.lineStart,
              lineEnd: meta.lineEnd,
              hasDocstring: !!meta.docstring,
            },
          };
        });

        return {
          chunks,
          totalCount: chunks.length,
          searchedSources: codebaseSources.length,
          searchedSourceNames: codebaseSources.map((s) => s.name),
          query,
          filters: {
            language: language ?? null,
            symbolType: symbolType ?? null,
            filePathContains: filePathContains ?? null,
          },
        };
      } catch (e) {
        logger.error('kb', 'search_codebase tool failed', { query: query.slice(0, 60) }, e);
        return {
          error: 'search failed',
          chunks: [],
          totalCount: 0,
          message: `Ошибка при поиске: ${e instanceof Error ? e.message : 'unknown'}`,
        };
      }
    },
  });
}

// ============================================================================
// Helper: list_codebase_symbols tool (опциональный, для exploratory search)
// ============================================================================

export function makeListCodebaseSymbolsTool(task?: Pick<AgentTask, 'goal' | 'fsScope'>) {
  return tool({
    description: `Получить список всех символов в кодовой базе (или в конкретном файле).
Используй когда:
- Нужно понять структуру проекта без чтения полных файлов
- Найти все файлы, где определён символ с определённым именем
- Получить обзор экспортируемых символов проекта

Возвращает компактный список: filePath, symbolName, symbolType, lineRange, isExported.
Не возвращает тела символов — используй read_file для деталей.`,
    inputSchema: z.object({
      filePath: z.string().optional().describe(
        'Путь к файлу (relativePath). Если не указан — символы всех файлов.'
      ),
      symbolType: z.enum(['function', 'method', 'class', 'interface', 'type', 'file']).optional().describe(
        'Фильтр по типу символа'
      ),
      exportedOnly: z.boolean().optional().describe(
        'Только экспортируемые символы (TS/JS)'
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        'Максимум результатов (по умолчанию 50)'
      ),
    }),
    execute: async ({ filePath, symbolType, exportedOnly, limit }) => {
      try {
        const codebaseSources = await selectCodebaseSourcesForTask({
          goal: task?.goal,
          fsScope: task?.fsScope,
        });

        if (codebaseSources.length === 0) {
          return { symbols: [], totalCount: 0, message: 'Нет подключённых кодовых баз.' };
        }

        const sourceIds = codebaseSources.map(s => s.id);

        const andConditions: Array<Record<string, unknown>> = [];

        const where: Record<string, unknown> = {
          sourceId: { in: sourceIds },
        };

        if (filePath) {
          where.metadata = { contains: `"filePath":"${filePath}"` };
        }
        if (symbolType) {
          andConditions.push({ metadata: { contains: `"symbolType":"${symbolType}"` } });
        }
        if (exportedOnly) {
          andConditions.push({ metadata: { contains: `"isExported":true` } });
        }
        if (andConditions.length > 0) {
          where.AND = andConditions;
        }

        const chunks = await db.chunk.findMany({
          where,
          select: {
            id: true,
            metadata: true,
            sourceId: true,
          },
          take: limit,
        });

        const symbols = chunks.flatMap(c => {
          let meta: {
            filePath: string;
            symbolType: string;
            symbolName: string;
            lineStart: number;
            lineEnd: number;
            isExported: boolean;
            language: string;
          };
          try {
            meta = JSON.parse(c.metadata);
          } catch {
            return [];
          }
          return [{
            id: c.id,
            sourceId: c.sourceId,
            filePath: meta.filePath,
            symbolName: meta.symbolName,
            symbolType: meta.symbolType,
            lineStart: meta.lineStart,
            lineEnd: meta.lineEnd,
            isExported: meta.isExported,
            language: meta.language,
          }];
        });

        return {
          symbols,
          totalCount: symbols.length,
          limited: symbols.length === limit,
          searchedSourceNames: codebaseSources.map((s) => s.name),
        };
      } catch (e) {
        logger.error('kb', 'list_codebase_symbols tool failed', {}, e);
        return { error: 'failed', symbols: [], totalCount: 0 };
      }
    },
  });
}
