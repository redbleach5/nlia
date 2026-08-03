# Agentic manual matrix (OSS)

Qualitative checklist vs Cursor-like expectations. Fill after manual runs on ≥2 repos.

| Repo | Size | Task | Steps | False DONE? | Diff quality | Notes |
|------|------|------|-------|-------------|--------------|-------|
| _(small lib)_ | S | fix test | | | | |
| _(app)_ | M | add function | | | | |
| _(monorepo fragment)_ | L | explain module | | | | |

## Checklist per run

1. Agent turn renders as **one** message from `parts[]` (no duplicate companion bubble).
2. 10+ tools: completed tools collapse; FPS usable.
3. Ask mode: disk unchanged until Apply; Apply all works.
4. Auto mode (Ctrl+Shift+A): writes without prompt after confirm.
5. `@file` large: signatures / truncate note; model can `read_file`.
6. Shell: `bun test` ok; `… && rm` / `npm run x -- --evil` blocked.
7. Rollback: restores pre-agent git tip or file undo stack.
8. Agent model = tools-capable (not Reasoning Distilled). See [`docs/AGENT-MODEL.md`](../AGENT-MODEL.md).

## Results log

_Add dated entries below when running P5c._
