# Architecture

The canonical Lia v3 architecture plan lives in **`Lia-v3-Architecture-Plan-v2.md`**
(v2.0, canonical, July 2026). This file is a quick-navigation mirror for IDEs and
coding agents; the plan document is the source of truth.

## Table of contents (mirrors the canonical plan)

| § | Topic | Plan section |
|---|-------|--------------|
| Executive summary | Greenfield rewrite rationale + 7 principles + stack | § Executive Summary |
| 1 | Context & motivation — what works in v2, what's broken | § 1 |
| 2 | Seven architectural principles | § 2 |
| 3 | Stack selection (Hono · Vite · Tauri · Drizzle · sqlite-vec · AI SDK) | § 3 |
| 4 | System architecture — process layout, sidecar, IPC | § 4 |
| 5 | Data model — Resource, Episode, Message, KB tables | § 5 |
| 6 | EpisodeWorkspace API | § 6 |
| 7 | Knowledge Base v3 | § 7 |
| 8 | Agent v3 — model-driven orchestration | § 8 |
| 8A | MCP spec | § 8A |
| 9 | Chat & Identity v3 | § 9 |
| 10 | Memory v3 | § 10 |
| 11 | UI/UX v3 | § 11 |
| 12 | Migration strategy v2 → v3 | § 12 |
| 13 | Implementation roadmap (M0–M8) | § 13 |
| 14 | Risk register | § 14 |
| 15 | Success metrics | § 15 |
| 16 | Open questions | § 16 |
| 17 | Appendix A: v2 → v3 file mapping | § 17 |
| Ap. B | Addendum A change history | § Appendix B |

## Where to look in this repo for each principle

| Principle | Plan § | Code location (M0 stub / M1+ target) |
|-----------|--------|--------------------------------------|
| 1. Unified EpisodeWorkspace | § 2.1 | `packages/shared/src/resource.ts` · `apps/backend/src/workspace/` (M2) |
| 2. Full KB indexing | § 2.2 | `apps/backend/src/kb/` (M4) |
| 3. Model-driven orchestration | § 2.3 | `apps/backend/src/agent/orchestrator.ts` (M5) |
| 4. Symbol-oriented code search | § 2.4 | `apps/backend/src/code/` (M6) |
| 5. Dynamic cognitive budget | § 2.5 | `apps/backend/src/agent/budget.ts` (M5) |
| 6. Long context as first-class | § 2.6 | `apps/backend/src/llm/context.ts` (M1+) |
| 7. Progressive retrieval | § 2.7 | `apps/backend/src/agent/tools/` (M5) |

## Decisions log (M0)

- **Runtime:** Node.js 24 (canonical). Bun 1.3 supported for compat only.
- **DB:** SQLite via `better-sqlite3` + `sqlite-vec` v0.1.9. `kb_vec_virtual` uses implicit `rowid` (mirrors v2 pattern).
- **Frontend:** Vite 5 (deduped across all workspaces; avoids plugin/version skew with `@vitejs/plugin-react` and `@tailwindcss/vite`).
- **Tauri:** M0 keeps the Rust shell minimal. Backend sidecar wiring lands in M1.
- **Drizzle:** schema declared in `apps/backend/src/db/schema.ts`; first drizzle-kit migration lands in M1 with the full data model. M0 uses `getDb()` idempotent table creation.
