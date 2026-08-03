# Knowledge Base — Agent Tools

> As-built. Код: `src/lib/kb/tools.ts` (+ wiring в `src/lib/agent/tools.ts`).

## KB tools

| Tool | Назначение |
|------|------------|
| `search_sources` | Hybrid search по KB (vector + BM25 + RRF) |
| `get_source` | Метаданные и превью источника |
| `list_sources` | Список источников |
| `read_folder_file` | Чтение файла из folder-source |

## Codebase tools (рядом, не в `kb/tools.ts`)

| Tool | Назначение |
|------|------------|
| `search_codebase` | Семантический поиск по codebase-source |
| `list_codebase_symbols` | Символы / структура проиндексированного кода |

## Citations

Результаты search возвращают chunk id / source name — в ответе указывать источник. UI: citation rendering в чате + KB drawer (`markdown-renderer.tsx`, `source-detail-modal.tsx`).

Обзор KB: [README.md](./README.md).
