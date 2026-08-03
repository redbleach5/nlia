# Core contract tests

Тесты **оркестраторов** chat/agent — не качество русского (LLM-judge), не KB chunking.

## Принципы

1. **Mock LLM, real logic** — `streamText` / `generateText` мокаются; SQLite — реальная test DB (`db/custom.db`).
2. **Контракт, не implementation** — assert outcomes: HTTP status, Message в БД, `tools: undefined` при proactive web search.
3. **Без Ollama в CI** — `test:ci` не требует запущенного Ollama.

## Файлы (`tests/core/`, **~179** cases)

| Файл | Что покрывает |
|------|----------------|
| `chat-tools.test.ts` | `decideChatTools()` — tools on/off matrix |
| `chat-pipeline.test.ts` | `runChatPipeline()` — happy path, 404, 503, web/KB tool lock, fallback |
| `agent-runner.test.ts` | `runAgentTask()` — plan/done, checkpoint resume, sweep, circuit breaker, cancel, loop, maxSteps |
| `agent-workspace-scope.test.ts` | workspace / fsScope resolution |
| `agent-sandbox-plan.test.ts` | write sandbox for coding goals |
| `agent-completion-signal.test.ts` | `ГОТОВО` / `DONE` completion |
| `loop-detector.test.ts` | `detectLoop()` — pattern / empty / llm_error |
| `pipeline-helpers.test.ts` | `buildFallbackResponse()` |
| `pipeline-helpers-context.test.ts` | `buildChatContext`, proactive web/KB search |
| `deliberate-self-check.test.ts` | `runDeliberate` / `runSelfCheck` gating |
| `persist-turn.test.ts` | `persistChatTurn` side-effects |
| `persist-to-chat.test.ts` | agent result → chat persistence |
| `memory-recall.test.ts` | `source_type` / `episode_id` isolation, `remember()` |
| `kb-step-utils.test.ts` | KB lookup / assisted goal heuristics |
| `kb-groundedness.test.ts` | groundedness helpers |
| `kb-evidence-completeness.test.ts` | evidence completeness |
| `grep-tool.test.ts` | agent grep tool |
| `code-seed.test.ts` | code exploration seed (Lia root only) |
| `resolve-agent-model.test.ts` | agent model slot resolve |
| `search-codebase-scope.test.ts` | codebase search scope |
| `step-history-compact.test.ts` | step history compaction |

Смежные unit-контракты: `tests/unit/api-validation.test.ts`, `fs-scope.test.ts`, `cognitive-depth.test.ts`.

## Запуск

```bash
bun run test -- tests/core
bun run test:ci   # включает tests/core/**
```

Перед KB vec-тестами (`tests/kb/db-vec-kb.test.ts`) остановите dev-сервер Lia — иначе возможен `SQLITE_BUSY`.

См. [docs/testing/README.md](../../docs/testing/README.md).
