# Claude Code в Лие — настройка на ПК

Как включить и проверить, что **project coding** идёт через Claude Code CLI + Ollama Anthropic Messages API (локально или remote GPU).

Связано: [`AGENT-MODEL.md`](./AGENT-MODEL.md) · [`REMOTE-OLLAMA.md`](../REMOTE-OLLAMA.md) · код `src/lib/agent/claude-code/`.

---

## Что должно быть установлено

| Компонент | Зачем | Как проверить |
|-----------|--------|----------------|
| **Claude Code CLI** | Executor coding-задач | `claude --version` |
| **Ollama** (локально или remote) | Модели через Anthropic-compatible API | `curl -s HOST:11434/api/tags` |
| **Lia** (`bun run dev`) | UI + spawn `claude` | Settings → Model |
| **Workspace проекта** | `fsScope` = реальный репо, не sandbox | Episodes → проект / путь |

Create Runtime (игры в sandbox), KB и обычный чат **не** идут через Claude Code.

---

## Чеклист «готово к работе»

1. [ ] `claude` в PATH (версия ≥ 2.x)
2. [ ] Ollama отвечает на хосте из Settings → Модель
3. [ ] Anthropic Messages API на этом хосте отвечает (см. ниже)
4. [ ] В UI включён **Coding: Claude Code**
5. [ ] Выбрана модель с tools + желательно ctx ≥ 64k
6. [ ] `bun run dev` запущен из терминала, где `which claude` находит CLI
7. [ ] Задача — правка/разбор **проекта** (не «создай игру» в sandbox)

---

## 1. Claude Code CLI

### Установка

Официально: [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code)  
Через Ollama launcher (опционально): `ollama launch claude` — см. [Ollama ↔ Claude Code](https://docs.ollama.com/integrations/claude-code).

Типичный путь на macOS после ручной установки:

```bash
claude --version
# пример: 2.1.218 (Claude Code)
which claude
# часто: ~/.local/bin/claude
```

Убедись, что `~/.local/bin` есть в `PATH` (zsh: `~/.zprofile` / `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Важно для Lia

Next.js/`bun run dev` наследует PATH **того процесса, из которого ты его запустил**.

- Запуск из терминала с `~/.local/bin` → Settings покажет «CLI найден».
- Запуск из GUI без PATH → «Claude Code CLI не найден» даже если CLI стоит.

Проверка:

```bash
which claude && bun run dev
```

---

## 2. Ollama + Anthropic Messages API

Lia выставляет для процесса `claude`:

```bash
ANTHROPIC_BASE_URL=<хост из Settings>   # без суффикса /v1
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=                      # пусто — не перебивать реальным Anthropic key
```

### Локальный Ollama

```bash
ollama serve
curl -s http://127.0.0.1:11434/api/tags | head
```

В Settings → Хост Ollama: `http://127.0.0.1:11434` (или пусто / localhost).

### Remote GPU (как у тебя: LAN / Tailscale)

1. На машине с GPU: `OLLAMA_HOST=0.0.0.0 ollama serve` (см. [`REMOTE-OLLAMA.md`](../REMOTE-OLLAMA.md)).
2. В Lia Settings → Хост: например `http://192.168.x.x:11434` или `http://100.x.x.x:11434`.
3. С ноутбука:

```bash
HOST=http://192.168.178.145:11434   # подставь свой

curl -sS "$HOST/api/tags"
curl -sS -X POST "$HOST/v1/messages" \
  -H 'content-type: application/json' \
  -H 'x-api-key: ollama' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"qwen3:14b","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
```

Ожидание: JSON с `"type":"message"`. Если connection refused — Ollama не запущена / firewall / неверный IP.

### Cloud-модели ollama.com

Два рабочих пути. Официально: [Authentication](https://docs.ollama.com/api/authentication) · [Claude Code + Ollama](https://docs.ollama.com/integrations/claude-code) · каталог [cloud](https://ollama.com/search?c=cloud).

В **Settings → Модель** cloud-теги (`*:cloud`) видны **только при включённом Claude Code**, в поле **Модель CC**. Чат и слот агента — только локальные модели (иначе системные промпты Лии сожрут лимиты ollama.com).

#### Путь A — через твой Ollama (LAN / localhost) + `ollama signin`

Cloud-запросы: Lia → твой Ollama → ollama.com. API key в Lia **не** нужен.

На **той машине, где крутится Ollama** (у тебя GPU-ПК `192.168.178.145`):

```bash
ollama signin          # один раз, аккаунт ollama.com
ollama pull glm-4.7:cloud   # или другая :cloud из каталога
# проверка (на ноуте, через тот же хост что в Settings):
curl -sS http://192.168.178.145:11434/api/tags | head
```

В Lia:

1. Хост Ollama — как сейчас (`http://192.168.178.145:11434`), **не** меняй на ollama.com.
2. Coding: Claude Code — ON.
3. Выбери cloud-модель в сетке или впиши тег (`glm-4.7:cloud`, …).

Плюс: не нужен API key в UI. Минус: GPU-ПК online и залогинен.

#### Путь B — напрямую на `https://ollama.com` (API key в Settings)

1. Ключ: [ollama.com/settings/keys](https://ollama.com/settings/keys).
2. В Lia → **Агент и память → Coding: Claude Code** → поле **Ollama API key** → сохранить.
   Либо `.env`: `OLLAMA_API_KEY=…` (fallback, если в DB пусто).
3. Выбери модель `*:cloud` только в **Модель CC** (не в чате и не в слоте агента).

Тогда spawn Claude Code ставит:

```bash
ANTHROPIC_BASE_URL=https://ollama.com
ANTHROPIC_AUTH_TOKEN=<твой ключ>
ANTHROPIC_API_KEY=
```

Без API key + cloud-модель → путь A (хост из Settings + токен `ollama`).

Проверка ключа:

```bash
curl -sS https://ollama.com/api/tags \
  -H "Authorization: Bearer $OLLAMA_API_KEY"
```

#### Какую cloud-модель брать

| Задача | Ориентир |
|--------|----------|
| Coding / Claude Code | теги с tools, из [cloud](https://ollama.com/search?c=cloud) (`glm-*:cloud`, `qwen3-coder*`, `minimax-*:cloud`, …) |
| Быстрые мелкие правки | меньший/faster cloud alias |
| Контекст | у cloud обычно полный ctx «из коробки» |

Имена в UI подтягиваются с каталога ollama.com (+ curated fallback).

#### Типичные ошибки cloud

| Симптом | Что сделать |
|---------|-------------|
| 401 / unauthorized | `ollama signin` на сервере Ollama **или** неверный API key в Settings / `.env` |
| model not found | другой тег / `ollama pull name:cloud` на хосте (путь A) |
| Lia всё ещё гоняет локальный qwen | в Claude Code явно выбери `…:cloud` в Cloud-сетке **Модель CC** |
| Чат с cloud падает без pull | путь A: pull на хосте; для CC предпочти путь B с API key |
---

## 3. Включение в UI Lia

1. Открой **Настройки → Модель**.
2. В блоке **Агент и память** включи **Coding: Claude Code**.
3. Проверь строку статуса CLI (найден / не найден).
4. Опционально: **Модель CC** (пусто = слот «Модель для агента» / чат).
5. Сохрани, если правил модель вручную.

Пока toggle **выключен**, coding идёт старым ReAct — это ожидаемо.

---

## 4. Выбор модели

Рекомендации для coding через CC:

| Требование | Зачем |
|------------|--------|
| Поддержка **tools** | Claude Code — tool loop |
| Контекст **≥ 64k** (лучше 128k) | Иначе CC деградирует на репо |
| Не обязательно «thinking»-режим | Лишняя латентность на каждом шаге |

Примеры (зависят от того, что уже `ollama pull`):

```bash
ollama pull qwen3:14b
# или крупнее / coder-oriented теги под твой VRAM
```

В Modelfile / параметрах Ollama для coding-модели выставь большой `num_ctx`, если по умолчанию маленький.

Слот **чат** можно оставить как есть; для CC удобнее отдельный слот агента или поле «Модель CC».

---

## 5. Как проверить end-to-end в Lia

1. Привяжи episode к **проекту** (реальный путь репо, не `agent-workspaces/...`).
2. Режим **Агент**.
3. Цель вроде: «Исправь X в `src/.../file.ts`» или «Разбери модуль Y».
4. В bubble/plan должно быть **«Claude Code · \<model\>»**, sticky — метка CC (без Ask|Auto).
5. После хода — diffs в Files / rollback через git snapshot.

Если fail «CLI не найден» — см. §1 PATH.  
Если fail Ollama — §2.  
Если снова крутится list_tree ReAct — toggle CC выключен или цель ушла в sandbox/KB.

### Ручной smoke без UI

```bash
HOST=http://127.0.0.1:11434   # или remote
MODEL=qwen3:14b
cd /path/to/your/project

ANTHROPIC_BASE_URL="$HOST" \
ANTHROPIC_AUTH_TOKEN=ollama \
ANTHROPIC_API_KEY= \
claude -p "Summarize what package.json says in one sentence." \
  --model "$MODEL" \
  --output-format text \
  --dangerously-skip-permissions
```

---

## 6. Типичные проблемы

| Симптом | Что проверить |
|---------|----------------|
| Settings: CLI не найден | `which claude`; PATH при старте `bun run dev` |
| Task failed: Ollama / preflight | Хост в Settings; `curl HOST/api/tags` |
| CC стартует, но «тупит» / рвёт контекст | `num_ctx` модели; взять модель побольше / без лишнего thinking |
| Правки не в том каталоге | Workspace episode = нужный `fsScope` |
| «Создай игру» всё ещё Create Runtime | Так и задумано (sandbox), не CC |
| Реальный Anthropic key «перебил» Ollama | В shell не должно быть `ANTHROPIC_API_KEY`; Lia при spawn обнуляет его у child |
| После рестарта сервера задача «висела» | CC без resume; stale → failed |
| Задача `executing` после того как файлы уже есть | После stream `result` Lia ждёт ~8s и SIGTERM CLI (локальные thinking-модели иногда не выходят сами) |

---

## 7. Снимок проверки на этой машине (ориентир)

Проверено на окружении разработчика:

| Пункт | Статус |
|-------|--------|
| Claude Code `~/.local/bin/claude` **2.1.218** | OK |
| PATH zsh включает `~/.local/bin` | OK |
| Локальный `127.0.0.1:11434` | **не запущен** (нормально при remote) |
| Remote Ollama в Settings | `http://192.168.178.145:11434` — отвечает, models: qwen3:14b/8b, qwen3.6, gpt-oss:20b, gemma4:12b, embed |
| `POST …/v1/messages` на remote | OK |
| `claude_code_enabled` в DB | **выкл.** → включить в UI |
| Отдельный agent model | нет → CC возьмёт `qwen3:14b` (чат); лучше задать CC/agent слот под coding + большой ctx |

Повтори команды из §2–§5 после смены сети/GPU.

---

## Краткий минимум

```bash
# 1) CLI
claude --version

# 2) Ollama (local или remote)
curl -sS "$OLLAMA_HOST/api/tags"

# 3) Anthropic-compatible
curl -sS -X POST "$OLLAMA_HOST/v1/messages" \
  -H 'content-type: application/json' -H 'x-api-key: ollama' \
  -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"

# 4) Lia: Settings → Coding: Claude Code ON → agent mode → правка файла в проекте
```
