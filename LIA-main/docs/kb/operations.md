# Knowledge Base — Operations

> Статус: Phases 1–5+7 ✅ · [README](./README.md)

## Безопасность

| Угроза | Защита |
|--------|--------|
| SSRF (URL sources) | `assertSafeUrl()` |
| Path traversal (upload) | `sanitizeFilename()`, `PATHS.artifacts/kb-uploads/` |
| Oversized upload | 50 MB + magic bytes |
| Indexing exhaustion | AbortController, batch embed (8), rate limits |

**Accepted risks:** нет audit trail, нет row-level ACL (single-user). Threat notes — в таблице выше; детали hardening — ниже.

## Производительность

- **Indexing:** `src/lib/kb/indexer.ts` — batch embed, incremental reindex, contentHash skip
- **Search:** FTS5 когда доступен, иначе JS inverted index + BM25 stemming
- **Оценка:** ~100 chunks/sec embed (nomic-embed-text локально)

| Оптимизация | Где |
|-------------|-----|
| Batch embedding (8) | `embed.ts` |
| Content hash dedup | `indexer.ts`, chunkers |
| Singleton `getDb()` | `db-vec-kb.ts` |

## Статус фаз

| Фаза | Статус |
|------|--------|
| 1–5, 7 | ✅ |
| 6 SSH | ⏸ отложена |
| Hardening | ✅ см. ниже |

**Не реализовано:** OS keychain для credentials (optional).

## Runtime-поведение

- **Context budget:** `search_sources` → top-10, truncated; полный текст через `get_source` / `read_folder_file`
- **Citations:** tool results включают `citation` + source metadata; рендер в `markdown-renderer.tsx`
- **Migration:** additive — `bun run db:push`, personal memory не затрагивается

## Hardening (июль 2026)

Краткий итог audit после Phases 1–7:

| Область | Решение | Код |
|---------|---------|-----|
| Dual-write atomicity | Rollback, ghost cleanup, reconcile job | `indexer.ts`, `reconcile.ts` |
| BM25 perf | Stemming, cached corpus stats, FTS5 | `bm25.ts`, `fts5.ts`, `inverted-index.ts` |
| Schema versioning | `kb_schema_version`, auto DROP+reindex | `db-vec-kb.ts` |
| Incremental reindex | File contentHash skip, chunk-hash diff | `indexer.ts` |
| Backup | Online Backup API | `bun run kb:backup` |
| Prompt safety | KB context в system prompt, без CAPS-директив | `pipeline-helpers.ts`, `system-prompt.ts` |

Тесты: `tests/kb/`

## Команды

```bash
bun run kb:backup
bun run kb:e2e
```

## Project / codebase create

Settings → База знаний → **Добавить проект** вызывает `POST /api/kb/project` (probe docs+code, до двух Source с общим `projectGroupId`).

Прямой API (без UI):

```bash
# Unified project (docs and/or code)
curl -X POST http://localhost:3000/api/kb/project \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Project","path":"/abs/path","mode":"auto","watchEnabled":true}'

# Probe only
curl -X POST http://localhost:3000/api/kb/validate-project \
  -H 'Content-Type: application/json' \
  -d '{"path":"/abs/path"}'

# Codebase-only (legacy / agent)
curl -X POST http://localhost:3000/api/kb/codebase \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Project","projectPath":"/abs/path","watchEnabled":true}'
```

## API-only (нет Settings UI)

```bash
# Secondary model (Ollama)
curl http://localhost:3000/api/settings/model-selection
curl -X PUT http://localhost:3000/api/settings/model-selection \
  -H 'Content-Type: application/json' \
  -d '{"secondaryModel":"qwen2.5:14b"}'
```
