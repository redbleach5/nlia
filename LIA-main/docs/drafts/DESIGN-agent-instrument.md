# DESIGN: ~1B как инструмент Лии (не второй мозг)

> Набросок 2026-07-22. **Не реализовано** — только черновик; не путать с roadmap чистки v2.
> Связано: `docs/ARCHITECTURE.md` · `src/lib/llm/resolve-agent-model.ts` · `src/lib/agent/runner*.ts`
>
> **2026-07-23:** для **project coding** путь superseded опциональным **Claude Code** backend
> (`src/lib/agent/claude-code/`, Settings → Coding: Claude Code). Лёгкий executor-слот
> для coding не развивать параллельно — один executor на цель.

---

## Тезис

**Лия = умная модель.** Характер, суждение, план, итог, companion — всегда у неё.

**~1B (или другая ультралёгкая tool-use) = её инструмент.** Быстрые «руки» для механических шагов: вызвать tool, разобрать JSON-ответ, сделать следующий вызов по уже заданному плану. Не заменяет Лию и не «разворачивает» смысл слотов «чат = ум, агент = тупой».

Аналогия: Лия думает и решает; лёгкая модель — отвёртка / терминал-оркестратор под её управлением. Упрощает и ускоряет многое, не становится лицом продукта.

Плохая формулировка (отклонить):

> чат = характер, агент = лёгкий tool-loop

Правильная:

> Лия (умная) ведёт задачу; лёгкая модель — опциональный executor под её планом и контролем.

---

## Зачем

1. **VRAM / residency** — умная модель не вылетает из GPU на каждом ReAct-шаге.
2. **Latency** — tool-шаги дешёвые; думать дорого только там, где нужно суждение.
3. **Не душить ум** — сохранить умную в центре и снять с неё рутину, а не делать Лию глупее «ради железа».

Не цель: сэкономить на интеллекте агента или сделать coding «на 1B».

---

## Что уже есть

| Кусок | Статус |
|-------|--------|
| Слот `agentModel` / `OLLAMA_AGENT_MODEL` | ✅ UI + DB + env |
| `resolveAgentModelName` (пусто = как у чата) | ✅ |
| `getAgentModel()` на plan / execute / synthesize | ✅ один слот на все фазы |
| Разные модели на plan vs execute vs synthesize | ❌ ещё нет |
| Escalate на умную при loop / weak plan | ❌ ещё нет |
| Явный статус «инструмент Лии» в UI/docs | ❌ |

Сейчас слот агента по комментариям ближе к «можно сильнее чата». Этот дизайн **не отменяет** сильный agent model; добавляет *другую* роль: **instrument / executor**.

---

## Роли моделей

```
┌─────────────────────────────────────────────────────────┐
│  Лия (smart / chat или явный strong agent)              │
│  — intent, plan, mid-course correction, synthesize      │
│  — companion, identity, «кто она»                       │
└──────────────────────────┬──────────────────────────────┘
                           │ поручает шаги / читает итог
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Instrument (~1–3B tool-use)                            │
│  — execute: tool call ↔ observation по плану            │
│  — без «личности», без финального голоса пользователю   │
└─────────────────────────────────────────────────────────┘
```

| Роль | Кто | Фазы runner сегодня | Обязанности |
|------|-----|---------------------|-------------|
| **Lia / brain** | умная | PLAN, SYNTHESIZE, error-analysis, ask_user framing | суждение, план, стоп, итог человеку |
| **Instrument** | ~1B tool-use | EXECUTE (ReAct step loop) | выбрать/вызвать tool в рамках плана, кратко зафиксировать observation |
| **Same-as-chat** | (fallback) | всё | если instrument не задан — как сейчас |

Имена настроек (предложение, не код):

- `agentModel` — оставить: «модель агента Лии» (brain для агентских задач; может = chat или сильнее).
- новый слот: `agentExecutorModel` / `OLLAMA_AGENT_EXECUTOR_MODEL` — инструмент; пусто = executor = brain (текущее поведение).

Не путать с `ollama_secondary_model` (KB/другое).

---

## Где instrument уместен

- Повторные tool-вызовы с узким контекстом (поиск → fetch → следующий fetch).
- Шаги с жёстким schema (имя tool + args), когда план уже написан Лией.
- Параллельные subagent-исполнители под одним планом родителя (осторожно с fs race — shared `fsScope`).

## Где только Лия (smart)

- PLAN / переплан после loop-detector.
- SYNTHESIZE — голос и смысл для человека = Лия.
- Coding judgment: что править, как читать падение теста, review diff.
- Self-study / identity — мозг не делегируется.
- Companion path, monologue, warmth — вообще не про executor.

Правило: **если сомневаемся — шаг делает Лия.** Instrument — оптимизация, не default identity.

---

## Минимальная архитектура (когда пойдём в код)

1. **Settings + env** — `agentExecutorModel` (optional). Capability profile учитывает третью роль в VRAM budget (observe/warn, не silent cut).
2. **`getAgentExecutorModel()`** — resolve: executor → else agent brain → else chat.
3. **`executeStep`** — streamText с tools на executor; system prompt *без* характера Лии, только: план, ограничения tools, format.
4. **`generatePlan` / `synthesize` / `analyzeAndStoreFailure`** — только brain (`getAgentModel()`).
5. **Escalate** — при loop, degenerate plan, N failed tools подряд, coding template → следующий шаг на brain; опционально полный replan.
6. **Telemetry** — в agent events: `modelRole: brain | executor`, имя модели (для отладки / activity log).
7. **Tests** — unit resolve chain; contract: synthesize никогда не на executor; module-integrity если новый import.

Не раздувать `runner.ts` — правки в `runner-helpers.ts` + тонкий resolve рядом с `resolve-agent-model.ts`.

### Псевдопоток

```
task start
  plan      ← brain
  loop:
    if needsJudgment(step, loopState):  step ← brain
    else:                               step ← executor
    checkpoint
  synthesize ← brain
```

`needsJudgment` — эвристики уже близкие к runner: loop-detector, useful material → early synthesize, degenerate plan, coding/self_researcher templates, ask_user.

---

## Кандидаты instrument (ориентир, не pin)

| Модель | Заметка |
|--------|---------|
| `qwen3:1.7b` | сильный native tool-use в мелком классе |
| `qwen3:0.6b` | ещё легче; больше escalate на brain |
| `qwen2.5:1.5b` / `3b` | запасной ряд |
| LFM2.x ~1B | быстро, но проверить Ollama tool format + coding escalate |

Выбор — через UI/smoke на real agent tasks, не через «вписали default в код».

---

## Анти-цели

- Не делать executor лицом Лии в чате/итоге.
- Не молча резать ctx / maxSteps / monologue «потому что есть 1B».
- Не считать coding «решённым» на ~1B без escalate на brain (plan/synthesize).
- Не мерить успех паритетом с облачными coding IDE.
- Не смешивать dialogue/emotional memory в executor-контекст без нужды.

---

## Открытые вопросы

1. Один executor на все templates или whitelist (web/KB да, coding/self_study нет)?
2. Держать brain + executor одновременно в VRAM (3060 12 GB) или swap осознанно?
3. Нужен ли короткий «brief от Лии» перед пачкой executor-шагов (1 вызов brain → N executor)?
4. Subagents: children всегда executor, parent всегда brain?
5. Как показать в UI, что «сейчас крутится инструмент», без ощущения второй личности?

---

## Следующий шаг (когда скажешь «делаем»)

1. Слот + resolve + wire только `executeStep`.
2. Escalate-эвристики минимальные.
3. Smoke: KB/web task с executor; coding task — убедиться, что brain не потерян.
4. Потом UI-копирайт («инструмент Лии», не «лёгкая модель агента»).

Пока документ живёт в корне как набросок; в `docs/` переносить после решения «идём» / отказа.
