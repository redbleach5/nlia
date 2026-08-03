# Knowledge Base — обзор

> **Статус:** Phases **1–5 + 7 реализованы**. Phase 6 (SSH) **отложена**.
>
> Глобальная база знаний: документы, папки проекта, URL, codebase indexing, hybrid search (vector + BM25 + RRF), UI.

## Реализовано

| Фаза | Что | Ключевые файлы |
|------|-----|----------------|
| 1 | Schema, `kb_vec_virtual`, API sources | `db-vec-kb.ts`, `prisma/schema.prisma` |
| 2 | Chunking, BM25, RRF, search, agent tools | `search.ts`, `indexer.ts`, `kb/tools.ts` |
| 5 | KB Sidebar, citations, Settings UI | `kb-sidebar.tsx`, `settings/kb-tab.tsx` |
| 7 | PDF/DOCX, URL crawler, file watcher, inverted index | `indexer.ts`, `file-watcher.ts`, `inverted-index.ts` |
| — | Hardening (FTS5, backup, setup) | [operations.md](./operations.md) |

**API-only:** secondary model — curl-примеры в [operations.md](./operations.md). Codebase через Settings → «Проект» или `POST /api/kb/project`.

## Документация по темам

| Файл | Содержание |
|------|------------|
| [architecture.md](./architecture.md) | Dual-Memory, принципы |
| [data-model.md](./data-model.md) | Prisma `Source`/`Chunk`, `kb_vec_virtual` |
| [chunking.md](./chunking.md) | Document, codebase chunkers |
| [search.md](./search.md) | Hybrid search: vector + BM25 + RRF |
| [agent-tools.md](./agent-tools.md) | `search_sources`, `get_source`, `list_sources` |
| [ui.md](./ui.md) | Settings tab, sidebar, citations |
| [operations.md](./operations.md) | Security, commands |

## Entry points

```
src/lib/kb/search.ts, indexer.ts, code-indexer.ts, tools.ts, file-watcher.ts
src/app/api/kb/
src/components/lia/kb-sidebar.tsx, settings/kb-tab.tsx
```

## Команды

```bash
bun run kb:backup
bun run kb:e2e
```

См. [operations.md](./operations.md).
