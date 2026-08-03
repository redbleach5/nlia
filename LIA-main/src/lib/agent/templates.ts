import 'server-only';

// Agent templates — presets for root tasks.

export type AgentTemplateName =
  | 'general'
  | 'researcher'
  | 'coder';

type AgentTemplate = {
  name: AgentTemplateName;
  label: string;
  systemPrompt: string;
  toolWhitelist: string[] | null;
  maxSteps: number;
  maxDurationSec: number;
};

export const AGENT_TEMPLATES: Record<AgentTemplateName, AgentTemplate> = {
  general: {
    name: 'general',
    label: 'Универсальный агент',
    systemPrompt: '',
    toolWhitelist: null,
    maxSteps: 15,
    maxDurationSec: 600,
  },

  researcher: {
    name: 'researcher',
    label: 'Исследователь',
    systemPrompt: `Ты — Research Agent. Твоя задача: найти точную, актуальную информацию по заданному вопросу.

Стратегия:
1. Начни с web_search по ключевым словам
2. Изучи топ-3 релевантные страницы через fetch_page
3. При необходимости — уточни поиск (другие ключевые слова)
4. Сохраняй важные находки через save_artifact (файл с заметками)
5. Ответь "ГОТОВО: <структурированная сводка находок>"

ПРАВИЛА:
- Ищи ОФИЦИАЛЬНУЮ документацию (API docs, RFC, спецификации)
- Проверяй дату: предпочитай свежие источники
- Цитируй конкретные факты, не обобщай
- Если информация противоречивая — укажи оба источника
- НЕ пиши код — только исследуй и сообщай`,
    toolWhitelist: ['web_search', 'fetch_page', 'save_artifact', 'read_file', 'list_tree', 'file_search', 'grep', 'search_codebase', 'list_codebase_symbols', 'search_sources', 'get_source', 'list_sources'],
    maxSteps: 10,
    maxDurationSec: 300,
  },

  coder: {
    name: 'coder',
    label: 'Программист',
    systemPrompt: `Ты — Coding Agent. Твоя задача: написать рабочий, протестированный код.

Стратегия (Create Runtime):
1. Design Gate уже выбрал preset (игры/сайты = static: index.html + style.css + script.js). Не изобретай vite/express/src/.
2. write_file строго по дереву lia.project.json (корень sandbox)
3. runtime_start без script override — дождись healthy (HTTP 200)
4. При ошибке — runtime_logs → edit_file → runtime_start
5. Тесты проекта (если есть) — run_command bun/npm/pytest; не для preview-сервера
6. git — через run_command при необходимости
7. code_run — только короткие сниппеты
8. save_artifact по желанию пользователя
9. «ГОТОВО: …» только после успешного runtime_start

ПРАВИЛА:
- Полный рабочий код, не заглушки
- Locked static preset: только index.html, style.css, script.js
- Не зацикливайся на read_file
- edit_file для правок; связанные файлы — write_files (batch) или несколько write_file в одном шаге
- Зависимости указывай только если preset их требует (vite-react / node-api)`,
    toolWhitelist: [
      'propose_design',
      'write_file',
      'write_files',
      'edit_file',
      'read_file',
      'list_dir',
      'list_tree',
      'file_search',
      'grep',
      'run_command',
      'code_run',
      'runtime_start',
      'runtime_logs',
      'runtime_stop',
      'save_artifact',
      'search_codebase',
      'list_codebase_symbols',
      'search_sources',
      'get_source',
      'ask_user',
    ],
    maxSteps: 20,
    maxDurationSec: 600,
  },
};

export function getTemplate(name: string | undefined | null): AgentTemplate {
  if (!name) return AGENT_TEMPLATES.general;
  return AGENT_TEMPLATES[name as AgentTemplateName] ?? AGENT_TEMPLATES.general;
}
