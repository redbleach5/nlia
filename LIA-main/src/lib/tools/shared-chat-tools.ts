import 'server-only';

import { tool } from 'ai';
import { z } from 'zod';
import { webSearch, fetchPage } from './web-search';
import { saveArtifact } from './save-artifact';
import {
  makeSearchSourcesTool,
  makeGetSourceTool,
  makeListSourcesTool,
  makeReadFolderFileTool,
} from '@/lib/kb/tools';

const WEB_SEARCH_DESCRIPTION =
  'Поиск в интернете для актуальной/фактологической информации. Возвращает топ-10 результатов: title, url, snippet. '
  + 'Используй когда: версии библиотек, свежие события, документация, ошибки с кодами. '
  + 'НЕ используй для философии, личных советов, математики.';

const FETCH_PAGE_DESCRIPTION =
  'Загрузить веб-страницу и извлечь читаемый текст. Используй ПОСЛЕ web_search '
  + 'чтобы прочитать содержимое конкретной страницы из результатов поиска. '
  + 'Возвращает текст (до 5000 символов) без HTML-тегов. '
  + 'Если error (мало текста) — отвечай по snippets web_search, не обещай «сейчас найду ещё».';

const SAVE_ARTIFACT_DESCRIPTION =
  'Сохранить артефакт (SVG, HTML, код, текст) как файл для пользователя. '
  + 'Используй когда сгенерировала SVG-логотип, HTML-страницу, скрипт, конфиг и т.п. '
  + 'Пользователь увидит карточку с превью и кнопкой «Скачать».';

export type SaveArtifactResult = Awaited<ReturnType<typeof saveArtifact>>;

export function createWebSearchTool(description = WEB_SEARCH_DESCRIPTION) {
  return tool({
    description,
    inputSchema: z.object({
      query: z.string().min(1).describe('Поисковый запрос (русский или английский)'),
    }),
    execute: async ({ query }) => webSearch(query),
  });
}

export function createFetchPageTool(description = FETCH_PAGE_DESCRIPTION) {
  return tool({
    description,
    inputSchema: z.object({
      url: z.string().min(1).describe('Полный URL страницы для чтения (из результата web_search)'),
      maxChars: z.number().optional().describe('Максимум символов текста (по умолчанию 5000)'),
    }),
    execute: async ({ url, maxChars }) => fetchPage(url, maxChars),
  });
}

export function createSaveArtifactTool(onSaved?: (result: SaveArtifactResult) => void | Promise<void>) {
  return tool({
    description: SAVE_ARTIFACT_DESCRIPTION,
    inputSchema: z.object({
      filename: z.string().min(1).describe('Имя файла, например "logo.svg" или "script.py"'),
      content: z.string().min(1).describe('Полное содержимое файла'),
      mime: z.string().default('text/plain').describe('MIME-тип, например "image/svg+xml" или "text/plain"'),
    }),
    execute: async ({ filename, content, mime }) => {
      const result = await saveArtifact({ filename, content, mime });
      await onSaved?.(result);
      const { path: _hostPath, ...safe } = result;
      return safe;
    },
  });
}

/** Chat pipeline tools: web + KB read + save_artifact. */
export function buildChatTools(opts?: { pinnedSourceIds?: string[] }) {
  return {
    web_search: createWebSearchTool(),
    fetch_page: createFetchPageTool(),
    save_artifact: createSaveArtifactTool(),
    search_sources: makeSearchSourcesTool({ pinnedSourceIds: opts?.pinnedSourceIds }),
    get_source: makeGetSourceTool(),
    read_folder_file: makeReadFolderFileTool(),
    list_sources: makeListSourcesTool(),
  };
}
