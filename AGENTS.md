# AGENTS.md — guidance for coding agents working on Lia v3

Use this when exploring or editing the repo (Cursor, Claude Code, Lia agent).
Goal: stay in high-signal code. Low-signal trees are usually **noise**.

## Where to start

| Area | What lives there |
|------|------------------|
| `apps/backend/src/` | Hono routes, Drizzle schema, sqlite-vec loader, services |
| `apps/backend/db/`  | Drizzle schema + SQL migrations |
| `apps/desktop/src/` | React 19 + Vite frontend (chat, workspace, settings UI) |
| `apps/desktop/src-tauri/` | Tauri 2.0 Rust shell (webview + sidecar launcher) |
| `packages/shared/`  | Types shared between backend and frontend |
| `docs/`             | Architecture, migration guides, ADRs |

## Architectural principles (v3)

1. **Unified EpisodeWorkspace** — one Resource API replaces v2's five file mechanisms
2. **Full KB indexing** by default — no manifest-only mode
3. **Model-driven orchestration** — single `streamText` with tools, no phase segregation
4. **Symbol-oriented code search** — Tree-sitter + call-graph index
5. **Dynamic cognitive budget** — function of model context, not hardcoded matrix
6. **Long context as first-class citizen** — no artificial 65k cap
7. **Progressive retrieval** — model decides when to search, not predictive heuristics

Full rationale: `docs/ARCHITECTURE.md` § 2.

## Stack

- **Backend:** Hono on Node.js, Drizzle ORM, better-sqlite3, sqlite-vec
- **Frontend:** React 19 + Vite + Tailwind CSS 4 + shadcn/ui + Zustand
- **Desktop:** Tauri 2.0 (Rust shell, optional)
- **LLM:** Vercel AI SDK + Ollama
- **Tests:** Vitest

## Coding conventions

- TypeScript strict mode everywhere (`tsconfig.base.json`)
- ESM modules (`"type": "module"`)
- Prefer named exports
- No `any` without an inline justification comment
- File names: `kebab-case.ts` for modules, `PascalCase.tsx` for components
- DB schema changes: generate migration with `npm run db:generate`, commit both schema + SQL

## What not to invent

- Don't recreate v2's `chat/attachments/`, `kb/folder-read.ts`, `agent/fs-scope.ts`, `agent/mentions.ts` — all replaced by `apps/backend/src/workspace/`
- Don't reintroduce `cognitive-depth.ts` matrix — dynamic budget per § 2.5
- Don't add `TIER_INFERENCE_CTX_CAP` — long context is first-class per § 2.6
- Don't add `needsProactiveWebSearch` / `shouldPreSearchKbForChat` — model-driven per § 2.7
- Don't put companion chat system prompts into coding executors

## Workflow

1. Anchor on the goal path or symptom (file, route, test name) — don't "map the entire monorepo"
2. `rg` for symbols; targeted `Read` over walking the tree
3. Match existing style; don't drive-by refactor unrelated files
4. Architectural questions: `docs/ARCHITECTURE.md` (mirror of `Lia-v3-Architecture-Plan-v2.md`)
5. All file writes under `/home/z/my-project/LIA-v3/` only
