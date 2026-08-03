# Knowledge Base — UI

> As-built. Settings / drawer / citations уже в приложении.

## Где в коде

| UI | Файл |
|----|------|
| Settings → База знаний | `src/components/lia/settings/kb-tab.tsx` (+ subcomponents) |
| KB drawer | `src/components/lia/kb-sidebar.tsx` |
| Citations в чате | message / citation components в `src/components/lia/` |

## Что умеет Settings tab

- Список источников (document, folder, codebase, url)
- **Добавить проект** — одна папка → документы (folder) и/или код (codebase), автоопределение
- Добавить документ / URL
- Reindex / sync / remove (включая codebase)
- Статус indexing; связанные источники помечены бейджем «проект»

## API (curl)

Codebase / project create, secondary model — [operations.md](./operations.md).

Обзор: [README.md](./README.md).
