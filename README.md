# Lia v3

**Status:** v3.0.0 — stable release ✅ (M0–M8 complete)
**Stack:** Hono · React 19 · Vite · Tauri 2.0 · Drizzle ORM · sqlite-vec · Vercel AI SDK · three.js + VRM
**Architecture:** see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — canonical mirror of `Lia-v3-Architecture-Plan-v2.md`

Personal AI companion — greenfield rewrite of v2.
Local-first, single-user, model-driven agent orchestration, unified EpisodeWorkspace API.

---

## v3.0.0 Release Notes

### Completed milestones (M0–M8)

| Milestone | Status | Highlights |
|-----------|--------|------------|
| M0 — Setup | ✅ | Monorepo, Hono + Drizzle + sqlite-vec, Tauri scaffolding, CI |
| M1 — Core infra + chat | ✅ | 8-table schema, streamText + SSE, Ollama integration, model slots |
| M2 — EpisodeWorkspace API | ✅ | Unified Resource abstraction, WorkspaceService, chat attachments |
| M3 — Identity + Memory | ✅ | Emotion perceive, 4-layer memory (facts/vector/emotional/decisions), reflection stub |
| M4 — KB full indexing | ✅ | Always-full indexer, BM25 + vector + RRF + MMR, file watcher |
| M5 — Agent model-driven | ✅ | Single streamText orchestrator, tool registry, PreFlightAskUser, loop detector |
| M6 — Symbol search | ✅ | Code parser (TS/JS/Python), codeSymbols + codeReferences, 5 agent tools |
| M7 — UI | ✅ | VRM avatar stub, AgentWorkbench, Markdown, 4-tab settings, keyboard shortcuts |
| M8 — Polish & packaging | ✅ | Migration script v2→v3, docs, ASSET_LICENSES, e2e test harness |

### Key features

- **Model-driven agent**: single streamText with tools — no phase-segregation (plan/execute/synthesize)
- **Unified workspace**: one Resource API replaces v2's 5 file mechanisms
- **Full KB indexing**: always-full content indexing, hybrid search (vector + BM25 + RRF + MMR)
- **Symbol-aware code search**: parse → extract symbols + references → list_references in one tool-call
- **4-layer memory**: episodic facts, global facts, emotional memories, decision log
- **VRM avatar**: 3D avatar with breathing + blink (emotion/lip-sync planned for v3.1)
- **Local-first**: all data in SQLite, LLM via Ollama, no cloud dependencies

### Migration from v2

See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the full v2→v3 migration guide.

```bash
# Dry run (recommended first)
cd apps/backend
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db --dry-run

# Live migration
npx tsx scripts/migrate-v2-to-v3.ts /path/to/v2/lia.db
```

---

## Repository layout

```
lia-v3/
├── apps/
│   ├── backend/                # Hono on Node.js — REST/SSE API, Drizzle, sqlite-vec
│   │   ├── src/
│   │   │   ├── agent/          # orchestrator, tool-registry, tools/, loop-detector, preflight
│   │   │   ├── chat/           # pipeline.ts, system-prompt.ts
│   │   │   ├── code/           # parser.ts, indexer.ts, service.ts (symbol search)
│   │   │   ├── db/             # client.ts, schema.ts, push.ts, migrate.ts
│   │   │   ├── identity/       # character, static-core, emotional-state, emotion, self-awareness
│   │   │   ├── kb/             # chunker, bm25, vector-search, rrf, search, indexer, file-watcher
│   │   │   ├── llm/            # ollama.ts
│   │   │   ├── memory/         # facts, fact-extraction, vector, emotional-memory, decisions, reflection-engine
│   │   │   ├── routes/         # health, capability, settings, episodes, messages, chat, resources, memory, search, agent, code, vrm
│   │   │   ├── services/       # episodes, messages
│   │   │   ├── workspace/      # service.ts (WorkspaceService)
│   │   │   └── index.ts
│   │   ├── db/migrations/      # drizzle-kit generated
│   │   ├── scripts/            # migrate-v2-to-v3.ts
│   │   └── tests/              # 12 test files, 130 tests
│   └── desktop/                # Vite + React 19 frontend + Tauri 2.0 shell
│       ├── src/
│       │   ├── components/     # ChatPanel, EpisodesSidebar, SettingsDialog, WorkspacePanel, AgentWorkbench, VrmAvatar
│       │   ├── lib/            # api.ts
│       │   ├── stores/         # episodes, chat, workspace (Zustand)
│       │   └── App.tsx
│       └── src-tauri/          # Rust shell
├── packages/
│   └── shared/                 # Types: health, resource, episode, message, chat, settings, kb, agent, code
├── docs/
│   ├── ARCHITECTURE.md
│   └── MIGRATION.md            # v2→v3 migration guide
├── .github/workflows/ci.yml
├── README.md
├── AGENTS.md
├── ASSET_LICENSES.md           # Third-party license registry (M8 final)
└── package.json
```

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | ≥ 22 (24 LTS recommended) | Backend runtime (chosen — see Runtime Decision below) |
| Bun | ≥ 1.3 (optional) | Alternative runtime, faster cold start |
| Rust toolchain | stable | Tauri 2.0 desktop shell build (`tauri dev` / `tauri build`) |
| Tauri system deps | see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/) | webkit2gtk, GTK, librsvg, libsoup-3, libayatana-appindicator |

> The Hono backend + Vite frontend run **without** Rust/Tauri — useful for web-only dev.
> Tauri is only required to produce the desktop binary.

## Quick start

```bash
# 1. Install deps
npm install

# 2. Approve native-addon install scripts (better-sqlite3, esbuild, sqlite-vec)
npm approve-scripts --allow-scripts-pending -y

# 3. Prepare .env
cp .env.example .env

# 4. Run DB migration (creates ./apps/data/lia.db with kb_vec_virtual)
npm run db:push

# 5a. Web-only — background start/stop (recommended)
npm start          # frees ports, starts backend+frontend, waits for health
npm run status     # ports + /api/health
npm stop           # stop + free :8787 / :5173
#   → UI  http://127.0.0.1:5173
#   → API http://127.0.0.1:8787/api/health
#   logs: data/lia-dev.log

# Attached to terminal (Ctrl+C stops):
npm run start:fg
# or classic foreground:
npm run dev

# 5b. Desktop dev (Tauri webview, requires Rust toolchain + Tauri system deps)
#     In a separate terminal:
npm run dev:backend
#     Then:
npm run tauri:dev
```
The backend serves `GET /api/health` → `{ status, runtime, sqliteVec, vecVersion, kbVecTable, schemaVersion, … }`.
The frontend (Vite dev server on port 5173) proxies `/api/*` to the backend on port 8787.

## M0 acceptance criteria — verified

| Criterion | Status | How to verify |
|-----------|--------|---------------|
| `/api/health` returns 200 | ✅ | `curl http://127.0.0.1:8787/api/health` |
| `sqlite-vec` extension loaded | ✅ | health response: `sqliteVec:true, vecVersion:"v0.1.9"` |
| `kb_vec_virtual` table exists | ✅ | health response: `kbVecTable:true` |
| Drizzle migration system works | ✅ | `npm run db:push` (idempotent; M1 adds first real migration) |
| Frontend dev server starts | ✅ | `npm run dev:frontend` → http://127.0.0.1:5173 |
| Tauri desktop window opens | ⚠️ requires local Rust | install Rust + Tauri system deps, then `npm run tauri:dev` |
| CI: typecheck + test + build | ✅ | `.github/workflows/ci.yml` (Node 22/24 matrix + Bun compat + Tauri build) |
| Runtime decision | ✅ | Node.js chosen — see below |

## Runtime decision (M0 outcome)

| Runtime | Status | Notes |
|---------|--------|-------|
| **Node.js 24** | ✅ Canonical | Stable for native addons (`better-sqlite3`, `sqlite-vec`), Tauri sidecar spawn, AI SDK streaming. Verified in CI matrix. |
| Bun 1.3 | ⚠️ Compatible, not canonical | CI `bun-compat` job smoke-tests `/api/health`; native addon compat risk on minor Bun updates. Use for scripts only. |

**Chosen: Node.js.** Bun remains a valid alternative; revisit after M5 if perf profiling justifies it.
The CI workflow runs a `bun-compat` job on every push to catch regressions early.

## Milestones

| # | Milestone | Status | Notes |
|---|-----------|--------|-------|
| M0 | Setup & stack validation | ✅ done | this commit |
| M1 | Core infra + chat | ⏳ next | DB schema full, streamText, SSE, episode CRUD, model slots |
| M2 | EpisodeWorkspace API | ⏳ | Resource abstraction, WorkspaceService |
| M3 | Identity + Memory | ⏳ | character, emotional state, episodic/global/emotional/semantic memory |
| M4 | KB full indexing | ⏳ | always-full folder indexer, hybrid search, reranker, HyDE |
| M5 | Agent model-driven | ⏳ | single streamText orchestrator, tool set, decision log, MCP |
| M6 | Symbol search | ⏳ | Tree-sitter 6 langs, codeSymbols/codeReferences, list_references |
| M7 | UI | ⏳ | chat panel, agent workbench, workspace panel, settings, 2D avatar |
| M8 | Polish & packaging | ⏳ | tests, Tauri bundle, docs, migration script v2→v3 |

See `docs/ARCHITECTURE.md` § 13 for the full roadmap.

## Tauri sidecar wiring (deferred to M1)

M0 intentionally keeps the Tauri shell minimal: `src-tauri/src/main.rs` opens the webview and logs startup. The backend runs as a sibling process (`npm run dev:backend`).

M1 wires the backend as a true Tauri sidecar via `tauri-plugin-shell`:
1. Build the backend into a self-contained Node bundle (esbuild + copied native addons).
2. Reference it in `tauri.conf.json` → `bundle.externalBin: ["../../backend/dist/lia-backend"]`.
3. `main.rs` spawns the sidecar on startup, polls `/api/health`, and kills it on window close.

This deferral keeps M0 focused on stack validation and avoids fighting native-addon bundling before M1 needs it.

## License

TBD — see `ASSET_LICENSES.md` for third-party asset attributions.
