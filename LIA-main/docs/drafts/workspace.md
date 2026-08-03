# Workspace — заметки / backlog

> Исторический план (2026-07-22). **Phases 4–6 shipped** в коде — см. [`ARCHITECTURE.md`](../ARCHITECTURE.md) (WorkspaceBadge, modes, memory, citations).  
> Этот файл — только оставшиеся идеи; не спецификация API.

Связано: `workspace-binding.ts` · `workspace-panel.tsx` · `docs/kb/README.md` · `DESIGN-agent-instrument.md`

---

## Уже в продукте

| Слой | Поведение |
|------|-----------|
| Episode binding | `WorkspaceBadge` — project / KB / sandbox |
| `fsScope` | binding → env → KB name match → Lia self → sandbox |
| Modes | Read / Explore / Edit + Apply ask\|auto |
| Memory | `workspace.<fingerprint>.*` facts |
| Mentions | `@file` / `@folder` + rules probe |

## Backlog (не DoD)

1. Ещё жёстче не уходить в пустой sandbox без confirm на coding goals (частично есть 409).
2. Pin «этот тред = один документ» для chat search без agent.
3. Богаче «что Лия помнит о папке» в UI.

## Принципы (актуальны)

1. **Явный выбор > эвристика.**
2. **Sandbox — черновик**, не основной workspace для «почини мой проект».
3. **KB и FS связаны**, но не смешиваются.
4. **Не маунтить корень Lia** без явного запроса.
5. **Характер Лии не в workspace.**
