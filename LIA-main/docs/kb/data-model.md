# Knowledge Base — Data Model

> As-built. Код: `prisma/schema.prisma`, `src/lib/kb/db-vec-kb.ts`, `src/lib/kb/types.ts`.

## Prisma

KB не привязана к `episode_id`. Лия читает через tools; write — через UI/API.

### Source

| Поле | Смысл |
|------|--------|
| `type` | `'document' \| 'folder' \| 'url' \| 'codebase'` |
| `name` | Человекочитаемое имя |
| `config` | JSON type-specific (см. ниже) |
| `status` | `'idle' \| 'indexing' \| 'ready' \| 'error' \| 'paused'` |
| `tags` | JSON array строк для UI / фильтров |
| `chunkCount`, `lastIndexedAt`, `errorMessage` | индекс / ошибки |

**config по типам:**

- `document`: `{ filePath, mimeType, fileSize, contentHash }`
- `folder`: путь + fingerprint / watcher metadata
- `url`: URL + title / hash после crawl
- `codebase`: root path, file hashes, symbol index metadata; часто с `projectGroupId` рядом с folder/docs

### Chunk

`content`, optional `summary`, `contentHash` (SHA-256), `metadata` (JSON: heading/path и т.д.), `parentId`, `position`, `indexedAt`. Cascade delete от `Source`.

Полная схема — в `prisma/schema.prisma` (модели `Source`, `Chunk`).

## Raw SQL: `kb_vec_virtual`

Инициализация в `src/lib/kb/db-vec-kb.ts` (тот же `getDb()` singleton, что и episodic vec):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec_virtual USING vec0(
  embedding float[768],
  source_id text,
  source_type text
);

CREATE TABLE IF NOT EXISTS kb_rowid_map (
  rowid INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  source_id TEXT NOT NULL
);
```

## Dual-write

sqlite-vec — runtime extension, не Prisma-native. Паттерн: `Chunk` в Prisma + embedding в `kb_vec_virtual`. Rollback / reconcile — [operations.md](./operations.md).

## BM25: FTS5 + JS fallback

Progressive enhancement в `inverted-index.ts` и `fts5.ts`:

- FTS5 в `better-sqlite3` → native full-text
- иначе JS inverted index + BM25 stemming (`bm25.ts`)

Тесты: `tests/kb/bm25.test.ts`, `tests/kb/inverted-index.test.ts`.

**Отложено:** Phase 6 SSH / logfile sources.
