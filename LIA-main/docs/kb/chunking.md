# Knowledge Base — Chunking

> As-built. Код: `src/lib/kb/chunkers/`, `code-chunker.ts`.

## Стратегии

| Тип | Модуль | Идея |
|-----|--------|------|
| Document (.md/.txt/.pdf/.docx) | `document-chunker.ts` | semantic / parent-child, contentHash |
| Codebase | `code-chunker.ts` + `code-indexer.ts` | per-file, hash только при полном success |
| URL | через indexer + Readability | см. `indexer.ts` |

## Инварианты

- Dual-write vector + Prisma (+ inverted): при fail после `insertKbVector` → `rollbackChunkWrite()`
- Codebase: не писать все `fileHashes` одним блоком в конце run (G21)

Обзор: [README.md](./README.md) · Data model: [data-model.md](./data-model.md).
