# Стратегия тестирования

> **Статус:** living document · **v3.6** (2026-07-23)  
> **Baseline:** `bun run test:ci` — основной gate

## Premise

Лия v2 **не нуждается в переписывании**. Задача тестов — ловить регрессии в оркестраторах (chat pipeline, agent runner), не гоняться за 100% coverage.

Agentic chat: unit gate + manual OSS matrix — [`agentic-manual-matrix.md`](./agentic-manual-matrix.md), protocol [`docs/AGENTIC-CHAT.md`](../AGENTIC-CHAT.md).

## Команды

| Команда | Назначение |
|---------|------------|
| `bun run test:ci` | **Основной gate** — vitest |
| `bun run test` | Все тесты |
| `bun run test -- tests/core` | Только контракты ядра (~**179**) |
| `bun run test:safe:local` | Стоп Lia на `:3000` → тесты → restart (`run-tests-safe.mjs`) |

`vitest.config.mts` подхватывает `.env` / default `DATABASE_URL` — локальный `test:ci` не требует ручного export (после `bun run setup` + `db:force-push`).

## Покрытие по слоям

| Категория | Тестов (≈) | Что покрывает |
|-----------|--------|---------------|
| `tests/core/` | **~179** | pipeline, agent runner, loop detector, deliberate/self-check, persist-turn, memory-recall, workspace/KB scope |
| `tests/unit/` | — | security utils, api-validation, fs-scope, message-parts, agentic-chat-p2-p7, … |
| `tests/kb/` | — | search, chunking, bm25, indexer, code-indexer |
| `tests/integration/` | ~16+ | peripheral-smoke |
| root (`paths`, `task-complexity`) | ~20 | paths, complexity classifier |
| **Collected** | **~868** (`bun run test`, 2026-07-23) | pass-count зависит от БД/env |

## Ядро — модули

| Модуль | Файлы | Контракты |
|--------|-------|-----------|
| Chat pipeline | `pipeline.ts` + phases/stream/helpers | ✅ `chat-pipeline.test.ts` |
| Agent runner | `runner.ts` + `runner-helpers.ts` | ✅ `agent-runner.test.ts` |
| Loop detector | `loop-detector.ts` | ✅ |
| Cognitive glue | deliberate helpers (runtime off), persist-turn | ✅ |
| Streaming self-check | disabled (cannot revise streamed answer) | — |
| Memory recall | vector, episodes, facts | ✅ `memory-recall.test.ts` |
| Workspace / KB scope | workspace-scope, sandbox-plan, kb-step-utils | ✅ |
| Message parts | `message-parts.ts` | ✅ `tests/unit/message-parts.test.ts` |

Оркестраторы тонкие; рост LOC — в helpers. Не обновлять таблицу LOC на каждый PR.

**Не ядро** (отдельно, хорошо покрыто): KB, security utils, paths, agent templates.

## Принципы

1. **Behavior-preserving first** — тест до рефакторинга
2. **Mock LLM, real logic** — Ollama не в core CI
3. **Контракт, не качество** — LLM-judge ≠ core gate
4. **test:ci + test:safe:local** — два пути прогона (CI gate / с освобождением `:3000`)

## Regression gate

`tests/unit/module-integrity.test.ts` — импортирует tool factories **без mock** `@/lib/ollama`. Ловит syntax errors в upstream модулях, которые прячутся за wholesale mock в core tests.

## Открытые пробелы

| Пробел | Приоритет |
|--------|-----------|
| RL subsystem **removed** 2026-07 | — |
| `isRepeatedMessage` — только peripheral-smoke | P2 |
| Global KB dedup (`LIA_KB_DEDUP`) | P3 |
| Test DB isolation (shared `db/custom.db`) | P3 |
| Semantic loop branch в `detectLoop` | P3 |
| Central `config.ts` для magic numbers | P3 |
| Manual OSS matrix fill-in | P2 |
