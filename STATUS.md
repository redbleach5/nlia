# Lia v3 — Статус проекта (v3.0.0 stable release)

**Дата:** 1 августа 2026
**Версия:** v3.0.0 (stable release)
**Последний коммит:** `30a12dc M8: Polish & packaging — migration script, docs, asset licenses, v3.0.0`
**Тег:** `v3.0.0`

---

## Все milestones завершены (M0–M8)

| Milestone | Недели | Статус | Коммит |
|-----------|--------|--------|--------|
| **M0** — Setup & stack validation | 1 | ✅ | `9fdd37d` |
| **M1** — Core infra + chat | 3 | ✅ | `f56fb56` |
| **M2** — EpisodeWorkspace API | 3 | ✅ | `2b4aac7` |
| **M3** — Identity + Memory | 4 | ✅ | `07e0bbb` |
| **M4** — KB full indexing | 4 | ✅ | `4551ca1` |
| **M5** — Agent model-driven | 4 | ✅ | `f9cc74f` |
| **M6** — Symbol search | 4 | ✅ | `7777355` |
| **M7** — UI | 4 | ✅ | `697723a` |
| **M8** — Polish & packaging | 2 | ✅ | `30a12dc` |

**Прогресс:** 9/9 milestones завершены (100%). ~29 недель плана выполнены.

---

## Что реализовано

### M0 — Setup & stack validation ✅
Monorepo (apps/backend Hono, apps/desktop Vite+React 19, packages/shared), SQLite + sqlite-vec + Drizzle ORM, AI SDK v7, Tauri 2.0 scaffolding, CI workflow. Runtime: Node.js 24.

### M1 — Core infra + chat ✅
8 таблиц (episodes, messages, settings, episodeFacts, globalFacts, emotionalMemories, vectorMemory, schemaMeta). Ollama integration (getChatModel, checkOllamaHealth, embedBatchUncached). Chat pipeline (streamText + SSE). Identity (character.ts + static-core.ts). Frontend: 3-column layout, ChatPanel, EpisodesSidebar, SettingsDialog.

### M2 — EpisodeWorkspace API ✅
`resources` table (14 columns). WorkspaceService (list/read/mount/attachInline/remove). Chat attachments through WorkspaceService. Frontend: WorkspacePanel, attachment chips.

### M3 — Identity + Memory ✅
`decisions` table. Emotion module (rule-based perceive, 9 triggers, 5-axis model, decay). Self-awareness. 4-layer memory (facts, fact extraction LLM, vector recall, emotional memory). Decision log CRUD. Reflection engine stub. System prompt: 8-layer stack. Background memory writes after companion turn.

### M4 — KB full indexing ✅
`chunks` table (embedding BLOB). Document chunker (2000 chars, paragraph boundaries, heading hierarchy). BM25 (JS, stemmer, IDF). Vector search (cosine similarity). RRF fusion + MMR diversification. Folder indexer (always-full, no manifest mode). Hybrid search orchestrator. Reranker stub. File watcher (chokidar).

### M5 — Agent model-driven ✅
`agentTasks` table (eventsJson, decisionIdsJson). Tool registry with availability predicates. 10 agent tools (fs, KB, web stubs, orchestration, execution stub). Orchestrator (single streamText, onStepFinish persist events, decision log auto-write). PreFlightAskUser gate. Loop detector. Circuit breaker. SSE stream endpoint.

### M6 — Symbol search ✅
`codeSymbols` + `codeReferences` tables. Code parser (regex-based, TS/JS/Python). Code indexer (parse → extract symbols + references → persist). Code service (searchSymbols, listReferences, listDefinitions, listImporters, listFileSymbols). 5 agent tools. Integration: mount(codebase) → background code indexing.

### M7 — UI ✅
VRM avatar stub (three.js + @pixiv/three-vrm, breathing + blink only). VRM backend (upload/download/delete with glTF validation). ChatPanel: Markdown rendering, mode toggle Chat/Agent. AgentWorkbench: inline parts[], decision log panel, SSE stream. SettingsDialog: 4 tabs (Model, Avatar, Identity, About). Keyboard shortcuts (Ctrl+,/B/A, Esc).

### M8 — Polish & packaging ✅
Migration script v2→v3 (`scripts/migrate-v2-to-v3.ts`): dry-run mode, per-row error reporting, 7 entity types migrated. Docs: `docs/MIGRATION.md` (full migration guide), README v3.0.0 release notes, `ASSET_LICENSES.md` (20+ dependencies). CI asset-license gate (active). Tag `v3.0.0`.

---

## Стек технологий

| Слой | Технология | Версия |
|------|-----------|--------|
| Backend | Hono on Node.js | 4.6 |
| Database | SQLite + sqlite-vec | better-sqlite3 11.7 + vec0 v0.1.9 |
| ORM | Drizzle ORM | 0.38 |
| LLM SDK | Vercel AI SDK | v7 |
| Frontend | React 19 + Vite 5 | — |
| CSS | Tailwind CSS 4 | beta |
| State | Zustand | 5.0 |
| 3D Avatar | three.js + @pixiv/three-vrm | 0.160 / 3.5.4 |
| Markdown | react-markdown + remark-gfm | 9.0 / 4.0 |
| Desktop | Tauri 2.0 | scaffolding |
| Tests | Vitest | 2.1 |
| Language | TypeScript | 5.7 (strict) |

---

## Метрики

| Метрика | Значение |
|---------|----------|
| Файлов в репо | 128 |
| Тестов | 130 (все зелёные, 12 файлов) |
| Таблиц в БД | 14 + kb_vec_virtual |
| Миграций Drizzle | 3 |
| Frontend bundle | 1.4 MB JS + 23 KB CSS (859 модулей) |
| Workspaces | 3 (backend, desktop, shared) |
| Коммитов | 9 (M0–M8) + tag v3.0.0 |
| Milestones | 9/9 (100%) |

---

## Как запустить

```bash
# 1. Установить зависимости
npm install
npm approve-scripts --allow-scripts-pending -y

# 2. Подготовить .env
cp .env.example .env

# 3. Применить миграции БД
npm run db:push

# 4. Web-only dev (backend + frontend, без Tauri)
npm run dev
#   → backend:  http://127.0.0.1:8787
#   → frontend: http://127.0.0.1:5173

# 5. Для чата нужен running Ollama:
#    ollama pull qwen3:8b
#    ollama pull nomic-embed-text

# 6. Для VRM аватара: загрузите .vrm файл в Settings → Avatar
```

## Миграция с v2

```bash
cd apps/backend
# Dry run (рекомендуется сначала)
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db --dry-run
# Live migration
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db
```

См. `docs/MIGRATION.md` для полного гайда.

---

## Архитектурные принципы v3 (все реализованы)

| # | Принцип | Где |
|---|---------|-----|
| 1 | Unified EpisodeWorkspace | `workspace/service.ts` |
| 2 | Full KB indexing by default | `kb/indexer.ts` |
| 3 | Model-driven orchestration | `agent/orchestrator.ts` |
| 4 | Symbol-oriented code search | `code/parser.ts` + `code/service.ts` |
| 5 | Dynamic cognitive budget | `agent/orchestrator.ts` (no hardcoded matrix) |
| 6 | Long context as first-class | `llm/ollama.ts` (no TIER_INFERENCE_CTX_CAP) |
| 7 | Progressive retrieval | `agent/tools/` (model decides via tool-use) |

## Что отложено на v3.1+

- VRM: emotion blendshapes, lip-sync, gaze tracking, gestures (M7 stub: breathing + blink only)
- MCP server + client integration (Addendum A.1)
- Real web_search / fetch_page (M5 stubs return empty)
- Sandboxed run_command (M5 stub returns empty)
- Go/Rust/Java code parsers (M6 has TS/JS/Python only)
- Cross-encoder reranker (M4 stub returns RRF as-is)
- Multi-query expansion + HyDE (M4 stubs, M5 wires LLM)
