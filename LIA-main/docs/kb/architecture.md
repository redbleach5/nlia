# Knowledge Base — Architecture

> Часть [KB-документации](./README.md). Статус: Phases 1–5+7 реализованы.

## 1. Мотивация и принципы

### Зачем это нужно

KB даёт Лие доступ к **бизнес-контексту** — документации проекта, URL, folder/codebase — отдельно от эпизодической памяти чатов.

### Ключевые принципы

1. **Dual-Memory** — бизнес-данные физически отделены от эпизодической памяти (`kb_vec_virtual` ≠ `vec_virtual`)
2. **Read-only для Лии** — KB источник знаний; Лия читает через tools
3. **Агент как потребитель** — доступ только через `search_sources` и др., не прямые SQL
4. **Local-first** — данные на диске пользователя; индексация через upload/watcher/crawl
5. **Progressive enhancement** — FTS5 когда доступен, JS BM25 как fallback

---

## 2. Ключевые проектные решения

| Решение | Почему |
|---------|--------|
| Dual-write (`Chunk` + `kb_vec_virtual`) вместо Prisma `vector` type | sqlite-vec — runtime extension, не Prisma-native |
| `Source` + `search_sources` naming | Consistency с `web_search`, `fetch_page` |
| SSH log search отложен (Phase 6) | `ssh2` issues на Windows; низкий demand |
| Settings + KB Sidebar | Быстрый доступ без открытия Settings |


## 3. Архитектура: Dual-Memory

```
┌──────────────────────────────────────────────────────────────────┐
│                    Agent (ReAct Loop) — tools.ts                   │
│    KB: search_sources, get_source, list_sources, read_folder_file   │
│    Code: search_codebase, list_codebase_symbols                    │
└────────────────────────┬─────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   Personal Memory   Knowledge Base    External
   (episodic)        (global)          Sources
   ├─ Episodes         ├─ Source        ├─ Local files
   ├─ Messages         │  document /    │  (upload/watcher)
   ├─ Emotional        │  folder /      ├─ URL crawl
   │  memory           │  url /         └─ Codebase root
   └─ Vector memory    │  codebase
      (per episode)    ├─ Chunk
                       └─ kb_vec_virtual
```

### Почему раздельно

| Аспект | Personal Memory | Knowledge Base |
|--------|-----------------|----------------|
| **Изоляция** | По `episode_id` (`vec_virtual`) | По `source_id` (`kb_vec_virtual`) |
| **Мутация** | Read-write (факты в `onFinish`) | Read-only для Лии; write через UI/API |
| **Chunking** | По сообщениям | По семантике источника (см. [chunking.md](./chunking.md)) |
| **Жизненный цикл** | Бесконечный, с decay (emotional) | Управляемый (add/remove/reindex) |
| **Объём** | Сотни фактов на эпизод | Десятки тысяч чанков на source |
| **vec0 table** | `vec_virtual` (`db-vec.ts`) | `kb_vec_virtual` (`db-vec-kb.ts`) |

**Главный выигрыш:** Лия остаётся тёплым собеседником, но получает бизнес-контекст через tools. Personal Memory не загрязняется KB-фактами.

---
