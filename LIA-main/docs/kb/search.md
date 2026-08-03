# Knowledge Base — Search

> As-built. Код: `src/lib/kb/search.ts`.

## Pipeline

1. **Vector** — `kb_vec_virtual` (`db-vec-kb.ts`)
2. **BM25** — FTS5 если доступен, иначе JS inverted index (`bm25.ts`, `inverted-index.ts`, `fts5.ts`)
3. **RRF** — слияние рангов (`rrf.ts`)
4. Enrich — метаданные source для citations

## Фильтры

`sourceTypes`, `sourceIds`, document heading — см. `SearchParams` в `search.ts`.

## Когда смотреть код

Поведение и edge cases (empty KB, tier gate, rollback) — только в исходниках; эта страница не дублирует реализацию.

Обзор: [README.md](./README.md) · Ops: [operations.md](./operations.md).
