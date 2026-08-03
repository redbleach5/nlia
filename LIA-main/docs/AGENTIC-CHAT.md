# Agentic chat — parts protocol + UI

> Source of truth for Cursor-like inline agent turns.  
> Code: `src/lib/agent/message-parts.ts`, `src/components/lia/agent-message-parts.tsx`

## Source of truth

One agent turn = one companion chat message with `parts: MessagePart[]`.

| Layer | Role |
|-------|------|
| SSE `AgentEvent` → `reduceAgentParts` | Only writer of bubble `parts` |
| Chat bubble (`AgentMessageParts`) | Only UX for plan / tools / ask / permission / apply |
| Sticky bar (`AgentStickyBar`) | Busy status + Ask\|Auto + turn rollback |
| Workbench | Optional **Files / Runtime** mirror (design, terminal, preview, diffs) — collapsed by default |
| `AgentWaitingPrompt` | Reconnect fallback only (when `ask` / `permission_request` not yet in parts) |

Do **not** remount thought-bubble / FlowTab progress next to the bubble — that duplicates the turn.

## MessagePart union

| type | Role |
|------|------|
| `status` | planning / executing / waiting_input / synthesizing / done / failed / cancelled |
| `plan` | goal + step titles |
| `text` | assistant prose (deltas accumulate; streaming cursor on active text only) |
| `tool_call` | tool card; `collapsed` when done |
| `edit_proposed` | pending Apply (ask mode) |
| `edit_applied` / `edit_rejected` | after user/auto decision |
| `ask` | ask_user — inline answer in bubble |
| `permission_request` | shell / network / mcp / write — Allow / Deny → `POST /api/agent/:id/input` |
| `runtime_log` | stdout/stderr snippet |

## Event → mutation

See `reduceAgentParts` in `message-parts.ts`. Key rules:

1. **Idempotency:** each event has `eventId` or a derived key; duplicates no-op (reconnect safe).
2. **`task_done`:** upserts status + merges `resultSummary` into text part.
3. **`file_changed` + `pending: true`:** → `edit_proposed`; else → `edit_applied`.
4. **Tool end:** auto-`collapsed: true` for perf.
5. Client may **optimistically** patch parts via `patchAgentTurnParts` (Apply / Reject / dismiss ask); SSE remains truth on reconnect.

## Perf defaults

- `MAX_EXPANDED_DIFFS = 3`
- `DIFF_PREVIEW_CHARS = 4000`
- Parts windowing when `parts.length > ~40` («Показать ранние N шагов»)
- Pending strip: «N файлов ждут» + **Применить все** (per-card Apply/Reject only)

## Apply gate (P3)

- Sticky client preference `agentApplyMode`: `ask` (default) | `auto`
- `localStorage` key `lia.agentApplyMode`; sent as `applyMode` on `POST /api/agent`
- UI: workspace-mode selector + sticky Ask\|Auto; hotkey **Ctrl+Shift+A** (in agent mode; otherwise cycles avatar)
- Ask: `write_file` / `edit_file` stage `edit_proposed` (disk untouched until Apply)
- APIs:
  - `POST /api/agent/:id/file-apply` — `{ changeId }`, `{ changeId, reject: true }`, `{ all: true }`
  - `POST /api/agent/:id/file-undo` — single / all
  - `POST /api/agent/:id/rollback` — git snapshot if available, else undo stack

## Mentions / rules (P2)

- Goal may include `@file:path`, `@folder:path`, optional `#L10-40`
- Composer: `@` autocomplete from episode workspace probe (`GET /api/episodes/:id/workspace/probe`)
- Rules badge: `AGENTS.md` / `.lia/rules.md` / `.cursorrules` (or «без rules»)
- Loader + context compress on the server (`rules-loader.ts`, `mention-context.ts`)

## Metrics (`AgentTurnMetrics`)

- `startedAt`, `firstTextAt` (TTFT)
- `toolStarts` / `toolSuccesses` / `toolFailures`
- `applyAccepts` / `applyRejects`

Manual OSS checklist: [`docs/testing/agentic-manual-matrix.md`](./testing/agentic-manual-matrix.md).
