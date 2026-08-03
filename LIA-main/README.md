# Лия — Personal AI Companion

## Запуск

### 1. Зависимости и Ollama

```bash
bun install

# Ollama: https://ollama.com — затем:
ollama serve          # отдельный терминал
ollama pull qwen3:8b            # быстрый старт (чат + агент)
ollama pull nomic-embed-text    # память (обязательно)
```

Windows: `bun install`, Ollama из Start Menu, те же `ollama pull` в PowerShell. Dev-сервер: `bun run dev`.

Модель выбирается в **Настройки → Модель** (клик сразу сохраняет).
Хост Ollama и модели хранятся в SQLite (UI) — это источник правды. Значения
`OLLAMA_*` в `.env` используются только как bootstrap при первом запуске
(пока в настройках ещё ничего не сохраняли).

**Удалённый Ollama (ноутбук + ПК с GPU):** в **Настройки → Модель → Хост Ollama**
укажи IP компьютера с видеокартой (LAN `192.168…` или Tailscale `100.x…`).
На том ПК: `OLLAMA_HOST=0.0.0.0 ollama serve`, на ноуте — `LIA_INFERENCE_VRAM_GB`
(ГБ VRAM удалённой карты). **С работы без белого IP** — см. корневой
[`REMOTE-OLLAMA.md`](./REMOTE-OLLAMA.md) (Tailscale, бесплатно для себя).

**Бэкап памяти Лии** (диалоги/настройки — не на GitHub): [`BACKUP.md`](./BACKUP.md).

### Выбор моделей

Три слота в UI: **чат**, **агент**, **память (embed)**. Конкретные теги — на вкус и под задачу; Lia не привязана к одной карте или семейству моделей.

| Слот | На что смотреть |
|---|---|
| **Чат** | Характер и качество диалога. Tools желательны, если в чате нужен поиск/KB. |
| **Агент** | Обязательно поддержка **tools** (Ollama `capabilities: tools`). Без tools агент деградирует в «только текст». Опционально: **Coding: Claude Code** в настройках — project coding через CLI + Ollama Anthropic API (см. [`docs/AGENT-MODEL.md`](./docs/AGENT-MODEL.md)). |
| **Память** | Отдельная embed-модель (`nomic-embed-text`, `bge-m3`, …). Не ставь chat-модель сюда. |

Ориентир по размеру (Q4, одна основная модель в VRAM):

- **~8–12 GB** → примерно **7–12B**
- **~16 GB** → до **~14B** комфортно
- **24 GB+** → можно крупнее

Чат и агент можно развести (разный характер / сильнее tools на агенте) или оставить одну модель на оба слота. Две крупные + embed на малой VRAM могут вытесняться — это нормально для Ollama, не баг Lia.

Быстрый старт выше (`qwen3:8b` + embed) достаточен, чтобы поднять проект; дальше меняй модели в настройках.


### 2. Настройка (один раз)

```bash
bun run setup    # .env, ключи, БД, hooks — или вручную: cp .env.example .env && bun run db:push
```

### 3. Dev-сервер

```bash
bun run dev      # http://localhost:3000 (macOS/Linux/Windows)
```

Сервер по умолчанию привязан к `127.0.0.1`: API агента, файловые инструменты и
база знаний не должны быть доступны из LAN. Удалённый API включается только
явно через `LIA_ALLOW_REMOTE=true` вместе с `LIA_INTERNAL_TOKEN`; клиент обязан
передавать токен в `x-lia-internal`. Встроенный browser UI остаётся
localhost-only (обычный `EventSource` не передаёт произвольные заголовки).

<details>
<summary><b>Опционально: VRM, ручная настройка .env</b></summary>

**VRM 3D:** файла `/models/lia_v2.vrm` нет в репо — нормально: CTA «Показать образ Лии» / soft empty state. Загрузка: **Настройки → Вид**.

**Ручная настройка:** `cp .env.example .env`, `openssl rand -base64 32` → `LIA_ENCRYPTION_KEY`, `bun run db:push`, `bun run setup:hooks`.

</details>

## Тестирование

```bash
bun run test             # все тесты (vitest)
bun run test:ci          # то же (CI gate)
bun run test:safe:local  # стоп Lia на :3000 → тесты → restart
bun run test -- tests/core   # только контракты ядра (~179)
```

Перед KB vec-тестами остановите `bun run dev` — иначе возможен `SQLITE_BUSY`. Подробности: [docs/testing/README.md](./docs/testing/README.md).

## Возможности

- **Чат со стримингом** — один `streamText` (tools на нетривиальных ходах); monologue/deliberate LLM выключены ради TTFT; markdown (react-markdown + GFM)
- **Эпизодическая память** — диалог и episode-facts изолированы по чату; профиль пользователя (`GlobalFact`) общий между чатами
- **Векторная память с sqlite-vec** — семантический поиск с pre-filter по `episode_id` + `source_type` (`dialogue` / `fact` / `summary` / `emotional`)
- **Агентский режим** — ReAct + checkpointing, ask_user, SSE → **inline `parts[]` в ленте**; Apply ask|auto, `@file`/`@folder`, rollback; шаблоны `general` / `researcher` / `coder`
- **3D VRM-аватар** — blendshapes для эмоций, дыхание, моргание, lip-sync; камера и фон в настройках
- **Capability tier** — авто-детект железа и размера модели → `micro` / `standard` / `plus` / `max` (отдельно chat tier и agent tier при разных слотах), кэш 1 час
- **Cognitive depth** — `classifyTaskComplexity` × `planExecution` → tools / maxTokens (без pre-stream LLM; web — `needsProactiveWebSearch`)
- **Agent tools** — FS (`read/write/edit_file`, `grep`, `list_*`, `file_search`), **`run_command`**, `code_run`, **Create Runtime** (`propose_design`, `runtime_start`/`logs`/`stop`), web, `save_artifact`, KB, codebase, `ask_user`, optional MCP — см. `src/lib/agent/tools.ts`
- **Create Runtime** — Design Gate → scaffold → Process Supervisor → Verify/Heal; вкладки в свёрнутом Agent Workbench
- **UI** — светлая «тёплый лён» палитра; Inter (UI) + Plus Jakarta Sans (display) + JetBrains Mono
- **Knowledge Base** — hybrid search (vector + BM25 + RRF). См. [docs/kb/README.md](./docs/kb/README.md)

## Стек

| Слой | Технология |
|---|---|
| Framework | Next.js 16 (App Router, Server Components) |
| Package manager | Bun (`bun install`, `bun run dev`) |
| Runtime | Node.js (Next.js dev/prod server runs on Node, not Bun — `better-sqlite3` is a native C++ addon not yet supported by Bun runtime) |
| БД | SQLite + `better-sqlite3` + `sqlite-vec` (vec0 virtual table) |
| ORM | Prisma + raw SQL через инкапсулированный vec-client |
| LLM | Ollama через `@ai-sdk/openai-compatible` |
| Streaming | Vercel AI SDK `streamText` + `AbortSignal.timeout` |
| 3D | three.js 0.160 + `@pixiv/three-vrm` + `@react-three/fiber` |
| UI | React 19 + Tailwind 4 + shadcn/ui (Radix primitives) |
| State | Zustand (4 slices + devtools + persist) |
| Markdown | react-markdown + remark-gfm |
| Logging | Pino (JSON prod, pretty dev) |
| Validation | Zod (основные POST/body routes + tool inputs) |

## Архитектура

Подробная схема — в [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). KB security/ops — в [docs/kb/operations.md](./docs/kb/operations.md).

```
src/
├── app/
│   ├── page.tsx                    # Client — HomeShell (3-колонный layout)
│   ├── layout.tsx                  # fonts, Toaster, server startup log
│   ├── error.tsx
│   └── api/                        # thin routes (zod → services)
│       ├── chat/                   # pipeline + attachments
│       ├── episodes/               # CRUD + cursor pagination + workspace + probe
│       ├── agent/                  # CRUD, start, stream (SSE), input, cancel,
│       │                           # workspace, file-apply/undo/rollback, runtime, mcp
│       ├── kb/                     # sources, search, project/codebase, health, …
│       ├── settings/               # Ollama, model-selection, VRM upload/download
│       ├── capability/             # GET profile + /refresh (chat+agent tier)
│       ├── artifacts/              # saved files download
│       └── health/
├── proxy.ts                        # Next.js proxy: X-Forwarded-For + LIA_INTERNAL_TOKEN
├── components/
│   ├── lia/
│   │   ├── settings/               # 4 tabs: model, avatar, kb, about
│   │   ├── vrm/                    # constants, background, blendshapes, gaze
│   │   ├── home-shell.tsx          # layout shell
│   │   ├── chat-*.tsx              # panel, message, input, attachments, mode
│   │   ├── agent-message-parts.tsx / agent-sticky-bar.tsx
│   │   ├── agent-workbench.tsx / workspace-panel.tsx / file-changes-panel.tsx
│   │   ├── kb-sidebar.tsx / source-detail-modal.tsx
│   │   ├── vrm-avatar.tsx / avatar-column.tsx / presence-stage.tsx
│   │   └── …                      # episodes, markdown, bootstrap
│   └── ui/                         # shadcn (Radix)
├── hooks/                          # chat, episodes, agent(+stream), health, presence
├── lib/
│   ├── chat/                       # pipeline, phases, stream (TTFT path)
│   ├── agent/                      # runner, message-parts, tools, mentions, rules,
│   │                               # runtime/ (Create Runtime)
│   ├── memory/                     # episodes, facts, vector, emotional, reflection
│   ├── kb/                         # indexer, search, bm25/FTS5, code-*
│   ├── identity/                   # character, decision (fallback), self-awareness
│   ├── llm/                        # resolve-agent-model, tool-support, error-summary
│   ├── tools/                      # web-search, save-artifact, code-run
│   ├── infra/                      # ssrf, api-validation, crypto, setup-wizard
│   ├── capability-profile.ts / compute-budget.ts / cognitive-depth.ts / task-complexity.ts
│   ├── ollama.ts / db.ts / db-vec.ts / paths.ts / logger.ts / …
│   └── server-startup.ts
├── stores/                         # Zustand: episodes, messages, agent, health
prisma/schema.prisma                # Episode, Message, ChatAttachment, facts, vectors,
                                    # EmotionalMemory, AgentTask, Setting,
                                    # Source, Chunk
```

## Ключевые архитектурные решения

### 1. Adaptive LLM pipeline (не фиксированная цепочка)

Основной ответ — один `streamText` с tools (на нетривиальных ходах). Pre-stream monologue / deliberate LLM выключены (TTFT). Cognitive depth режет tools / maxTokens по tier × complexity; proactive web — `needsProactiveWebSearch`, не поле плана.

### 2. Память привязана к episode_id + source_type

```sql
SELECT v.rowid, v.distance, m.vector_id
FROM vec_virtual v
JOIN vec_rowid_map m ON v.rowid = m.rowid
WHERE m.episode_id = ?        -- PRE-FILTER на SQL уровне
  AND v.source_type = ?       -- 'dialogue' | 'emotional' — no cross-contamination
  AND v.embedding MATCH vec_f32(?)
ORDER BY v.distance LIMIT ?
```

Утечек **диалога** между чатами нет архитектурно (episode filter). Dialogue recall не смешивает `emotional` якоря. `sourceType`: `'dialogue'` / `'emotional'` / `'fact'` / `'summary'` — chat recall по умолчанию ищет `dialogue` + `fact` + `summary`. Профиль пользователя (`GlobalFact`, например имя) общий между эпизодами — это намеренно.

### 3. Agent resume через checkpoint

После каждого шага сохраняется `checkpointJson = { plan, steps, savedAt }`. При restart сервера `sweepStaleTasks()` (вызывается из `server-startup.ts` на старте процесса) сбрасывает `executing`+`checkpoint` задачи в `pending` — runner пропускает PLAN и продолжает с `steps.length`. Задачи без checkpoint в transient-статусе помечаются `failed` с понятным сообщением.

### 4. Pino logging + Zod validation

Все основные POST/body routes валидируются через Zod (`parseBody`). Логирование через Pino — JSON в production, pretty в development.

### 5. SSRF + sandbox + path traversal protection

- `lib/infra/ssrf.ts` — `assertSafeUrl` для всех URL от LLM (блокирует private IP, CGNAT, link-local, IPv4-mapped IPv6)
- `lib/tools/code-run.ts` — Python AST analysis + `resource.setrlimit` на Unix (на Windows лимиты resource недоступны)
- `lib/agent/fs-scope.ts` — `safePathWithinScope` с realpath для symlink protection

### 6. Кросс-платформенные пути

Все пути резолвятся через `src/lib/paths.ts` — `PROJECT_ROOT` из `LIA_ROOT` env или `process.cwd()`. Работает на macOS, Windows, Linux. `DATABASE_URL` в `.env` — `file:../db/custom.db`. Префикс `../` нужен Prisma (резолв относительно `prisma/schema.prisma`); `resolveDbPath()` в `paths.ts` снимает `../` для better-sqlite3, чтобы оба слоя открыли **один** файл. Без `../` в URL Prisma уйдёт в `prisma/db/…` — другая БД, векторная память «потеряется».

### 7. Capability tier — авто-адаптация под железо

`lib/capability-profile.ts` + `compute-budget.ts` определяют GPU/VRAM и размер моделей (Ollama `/api/show`). Tier в первую очередь от **размера модели** (+ floors: CPU / известный VRAM ниже 8 GB → `micro`). При remote Ollama без `LIA_INFERENCE_VRAM_GB` VRAM-floor не применяется.

Два tier'а: **chat** (cognitive depth диалога) и **agent** (лимиты ReAct), если слоты моделей разные.

| Tier | Условие (размер модели) | Стратегия чата | Agent limits |
|---|---|---|---|
| `micro` | ≤4B, или CPU / VRAM ниже 8 GB (если pool известен) | 1 LLM call, `web_search` чаще | 10 шагов / 10 мин |
| `standard` | 5–13B | 1 call на лёгких; deliberate+self-check на complex/research | 25 шагов / 1 час |
| `plus` | 14–32B | 2–4 calls, deliberate + self-check | 100 шагов / 6 часов |
| `max` | 33B+ | полная глубина | 500 шагов / 24 часа |

Профиль кэшируется в `Setting` (`capability_profile`), TTL 1 час. Обновляется при смене модели или `POST /api/capability/refresh`. Отдельного chip в шапке нет.

### 8. Cognitive depth — адаптивный pipeline

`lib/cognitive-depth.ts` комбинирует 3 сигнала:

1. **Mode** (UI): `auto` (диалог) / `agent`
2. **Tier** (chat tier из capability profile)
3. **Complexity** (`lib/task-complexity.ts` → `trivial` … `research`)

Результат — `ExecutionPlan`: tools / maxTokens.  
Proactive web — `needsProactiveWebSearch` (не поле плана).  
`deliberate` и monologue LLM сейчас **всегда off** (latency pass); self-check в streaming тоже off.

### 9. Circuit breaker + LLM-error-aware loop detection

- `agent/runner.ts`: 3 consecutive `streamText` errors → задача fail'ится с понятным сообщением (вместо бесконечных ретраев).
- `agent/loop-detector.ts`: `LLM_ERROR_MARKERS` (timeout, `ECONNREFUSED`, `AI_APICallError`) НЕ считаются «пустым результатом».
- `agent/loop-detector.ts`: pattern-loop сравнивает input через `stableStringify`.
- `chat/pipeline-stream.ts`: wrapped chat stream с `cancel()` — при закрытии вкладки reader освобождается сразу.
- `chat/pipeline.ts`: при падении модели — RU fallback в UI, не HTTP 500.

## Настройка через UI

Все повседневные настройки доступны в диалоге **Настройки** (иконка ⚙️):

1. **Модель** — Ollama: chat / agent / embed слоты
2. **Вид** — тема, VRM (загрузка/выбор), кадр и фон
3. **База** — Knowledge Base sources
4. **О Лии** — имя пользователя и описание продукта

Через терминал нужно только:
- Установить Ollama (один раз)
- Скачать модели (`ollama pull …`) — в UI Lia pull не делает (хотя у Ollama есть `/api/pull`)

Повседневные настройки — через UI. Тонкая настройка инференса/агента/KB — также через `.env` (см. `.env.example`).

## Roadmap

- [x] MVP — chat, episodes, инструменты, 2D аватар
- [x] Agent runner — ReAct-loop с SSE
- [x] VRM 3D avatar — blendshapes, breathing, blink, lip-sync (three.js + @pixiv/three-vrm)
- [x] Settings UI — все настройки в одном диалоге
- [x] Agent templates — `general` / `researcher` / `coder`
- [x] Resume after restart — checkpoint после каждого шага, восстановление при перезапуске
- [x] Capability tier — авто-адаптация под железо (micro / standard / plus / max; chat + agent)
- [x] Cognitive depth — adaptive pipeline (mode × tier × complexity)
- [x] Knowledge Base Phases 1-5 — Documents + hybrid search (vector + BM25 + RRF) + UI (см. [docs/kb/README.md](./docs/kb/README.md))
- [x] Knowledge Base Phase 7 — PDF/DOCX, URL crawler, file watcher, BM25 inverted index
- [x] ReflectionEngine — консолидация эмоциональной памяти
- [x] Core contract tests — `tests/core/**` · ~**868** collected (`bun run test`) — [docs/testing/README.md](./docs/testing/README.md)
- [x] Agentic chat UI — inline `parts[]`, Apply ask|auto, `@` mentions, sticky bar — [docs/AGENTIC-CHAT.md](./docs/AGENTIC-CHAT.md)
- [ ] Local agent reliability — groundedness, OSS matrix fill-in
- [ ] Knowledge Base Phase 6 — SSH on-demand log search (отложено, см. [docs/kb/README.md](./docs/kb/README.md))

**Вне скоупа:** Voice/TTS, Tauri/mobile, multi-user/auth, plugin marketplace, паритет с облачными coding IDE.

## Документация

| Документ | Содержание |
|----------|------------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Архитектура, chat/agent flow, memory |
| [docs/AGENTIC-CHAT.md](./docs/AGENTIC-CHAT.md) | Agentic parts + UI contract |
| [docs/AGENT-MODEL.md](./docs/AGENT-MODEL.md) | Chat vs agent model guidance |
| [docs/CLAUDE-CODE.md](./docs/CLAUDE-CODE.md) | Claude Code + Ollama: установка и проверка на ПК |
| [docs/kb/](./docs/kb/README.md) | Knowledge Base |
| [docs/testing/](./docs/testing/README.md) | Стратегия тестов |
| [tests/core/README.md](./tests/core/README.md) | Core contract tests |
| [docs/drafts/DESIGN-agent-instrument.md](./docs/drafts/DESIGN-agent-instrument.md) | Черновик: лёгкая модель как инструмент агента |

## Диагностика проблем

Если что-то не работает — запусти диагностику:

**Быстрая (кросс-платформенная):** `bun run diagnose` — Node.js-скрипт, проверяет Ollama, БД, пути.

**Полная (с лог-файлом):**

### macOS / Linux

```bash
bash scripts/diagnose.sh
```

### Windows (PowerShell нативно, без WSL)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1
# С детализацией:
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1 -Verbose
```

Полная диагностика сохраняет лог в `diagnose-YYYYMMDD-HHMMSS.log` — приложи его к сообщению об ошибке.

## Команды для Windows

Большинство npm-скриптов кросс-платформенные (`.mjs`). Отдельные PowerShell-варианты — только для tail логов:

| Действие | Команда |
|---|---|
| Dev-сервер | `bun run dev` |
| Тесты (CI) | `bun run test:ci` |
| Typecheck приложения и тестов | `bun run typecheck && bun run typecheck:tests` |
| Lint | `bun run lint` |
| Сборка | `bun run build` |
| Инициализация БД | `bun run db:push` (патчит схему без wipe) |
| Диагностика (быстрая) | `bun run diagnose` |
| Диагностика (полная) | `powershell -File scripts\diagnose.ps1` |
| Логи real-time | `bun run logs:tail:win` |
| Логи агента | `bun run logs:agent:win` |
| Логи ошибок | `bun run logs:errors:win` |

## Полезные команды

| Команда | Что делает |
|---|---|
| `bun run setup` | Полная настройка новой машины: .env, ключи, БД, hooks |
| `bun run setup:hooks` | Установить git pre-commit hook (защита от утечки токенов) |
| `bun run kb:backup [path]` | Атомарный backup SQLite DB (через Online Backup API) |
| `bun run kb:restore <file.db>` | Восстановить live DB из backup (см. [`BACKUP.md`](./BACKUP.md)) |
| `bun run diagnose` | Быстрая диагностика (Ollama, БД, пути) |
| `bun run diagnose:verbose` | То же с подробным выводом |
| `bun run test` | Vitest — все тесты |
| `bun run test:ci` | Основной CI gate (vitest) |
| `bun run typecheck` | TypeScript-проверка приложения |
| `bun run typecheck:tests` | TypeScript-проверка приложения и тестов |
| `bun run check:scripts` | Синтаксическая проверка всех JS/MJS-скриптов |
| `bun run lint` | ESLint для приложения и тестов |
| `bun run test:safe:local` | Стоп :3000 → тесты → restart |
| `bun run kb:e2e` | KB smoke: upload → chat → agent |
| `bun run db:push` | Инициализация БД + **additive schema patches** (без wipe) |
| `bun run db:patch` | Только additive patches (attachments и т.п.) |
| `bun run db:force-push` | Пересоздать БД с нуля (УДАЛЯЕТ все данные) |
| `bun run kb:export` / `kb:import` | Экспорт / импорт KB |
| `bun run ollama:backup` / `ollama:restore` | Бэкап / восстановление моделей Ollama |
| `bun run build:standalone` | Standalone Next build (deploy) |

## Отправка баг-репорта

При проблемах приложи:
1. **Лог диагностики**: `diagnose-*.log`
2. **Dev-лог**: `dev.log`
3. **GPU информация** (Windows): `nvidia-smi`
4. **Модели Ollama**: `ollama list`
5. **Шаги воспроизведения**: что делал, что ожидал, что получилось

## Лицензия

[MIT](./LICENSE) — используй, модифицируй, распространяй свободно с attribution.

Copyright © 2026 redbleach5
