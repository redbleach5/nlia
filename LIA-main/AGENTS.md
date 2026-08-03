# Lia — guidance for coding agents

Use this when exploring or editing the repo (Cursor, Claude Code, Lia agent).
Goal: stay in high-signal code. Low-signal trees are usually **noise**, not forbidden forever —
open them only when the task *explicitly* needs that path.

## Where to start

| Area | What lives there |
|------|------------------|
| `src/lib/` | Core: chat pipeline, agent, KB, memory, Ollama, prompts |
| `src/lib/agent/` | ReAct runner, tools, Claude Code bridge, create-runtime |
| `src/app/api/` | Next.js route handlers |
| `src/components/lia/` | Product UI |
| `src/stores/` | Client state (Zustand) |
| `tests/` | Vitest — prefer `tests/core/` for agent/chat contracts |
| `docs/` | Architecture & how-to (`AGENT-MODEL.md`, `CLAUDE-CODE.md`, …) |
| `prisma/schema.prisma` | DB schema |

Paths resolve via `src/lib/paths.ts`. Prefer **grep / targeted read** over walking the whole tree.

## Low-signal — skip unless the task names them

These burn context and almost never explain product behavior:

| Path / pattern | Why it’s usually useless |
|----------------|--------------------------|
| `node_modules/`, `.next/`, `out/`, `build/`, `dist/`, `coverage/` | Build/deps artifacts — not source of truth |
| `db/`, `*.db*` | Local SQLite runtime data |
| `.env`, `.env.*` (except `.env.example`) | Secrets; use example + Settings docs instead |
| `download/`, `upload/`, `public/models/*.vrm` | User/runtime binaries & sandboxes |
| `*.pt`, `*.onnx`, weights, large datasets | Model blobs — not app logic |
| `.zscripts/`, `tool-results/`, `mini-services/`, `examples/` | Side tooling, not Lia core |
| `diagnose-*.log`, `*.log`, `dev.log` | Ephemeral diagnostics |
| `.cursor/plans/`, agent-transcript dumps | Session scratch, not product code |
| Lockfile churn / generated `next-env.d.ts` | Noise unless dependency task |

If the user @mentions a path or the bug is clearly there — read it. Otherwise prefer `src/` + relevant `docs/` + `tests/`.

## Workflow

1. Anchor on the goal path or symptom (file, API route, test name) — don’t “map the entire monorepo”.
2. `list_tree` / broad search: start under `src/lib/…` or the package the task names; widen only if empty.
3. Match existing style; don’t drive-by refactor unrelated files.
4. Agent/chat architecture: `docs/AGENT-MODEL.md`, `docs/CLAUDE-CODE.md`, `docs/ARCHITECTURE.md`.
5. Coding via Lia Claude Code: keep edits inside the workspace `fsScope`; no force-push / `git reset --hard`.

## Stack (quick)

Next.js · TypeScript · Bun · Prisma/SQLite · Ollama · AI SDK · Vitest.

## What not to invent

- Don’t treat sandbox / `download/agent-workspaces/` as the Lia app source.
- Don’t assume local-only Ollama — host may be remote (Settings / `REMOTE-OLLAMA.md`).
- Don’t put companion chat system prompts into coding executors (see `docs/AGENT-MODEL.md`).
