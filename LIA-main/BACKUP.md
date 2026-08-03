# Бэкап и восстановление Лии

Когда Лия «та самая» — сохрани **память** (SQLite) и при желании
**список моделей** Ollama. Код уже на GitHub; личную БД туда **не** лей.

| Что | Где живёт | На GitHub? |
|---|---|---|
| Характер, промпты, логика | git | да |
| Диалоги, факты, настройки UI | `db/custom.db` | **нет** |
| Какие модели стояли | `ollama-backup-*.json` | лучше нет |
| Веса моделей | диск Ollama | нет (только `pull` заново) |

---

## Сохранить (snapshot «эпохи»)

Останови чат на секунду не обязательно, но лучше не писать в БД в момент бэкапа.

### 1. Память и отношения (главное)

```bash
# из корня репо — нужен Node (better-sqlite3), не Bun runtime
bun run kb:backup
```

Файл появится в `db/backup-YYYY-MM-DD-….db`.

Именной снимок:

```bash
bun run kb:backup db/backup-sweet-era-2026-07-23.db
```

Скопируй `.db` ещё и **вне** репо (Desktop, внешний диск, Time Machine):

```bash
mkdir -p ~/Desktop/LIA-backups
cp db/backup-sweet-era-2026-07-23.db ~/Desktop/LIA-backups/
```

`db/` и `*.db` в `.gitignore` — в git случайно не уедут.

### 2. Список моделей Ollama (опционально)

На машине, где крутится Ollama (или с `OLLAMA_BASE_URL` на неё):

```bash
bun run ollama:backup
# → ollama-backup-YYYY-MM-DD.json в корне (тоже в .gitignore)
```

Это **не** веса, а инвентарь + Modelfile’ы для `pull` / `create` при переезде.

### 3. Заметка к эпохе (30 секунд)

В тот же `~/Desktop/LIA-backups/` текстовый файл, например:

- дата
- модель чата / агента (из Настройки → Модель)
- `OLLAMA_BASE_URL` / Tailscale IP
- `LIA_INFERENCE_VRAM_GB`
- одна фраза: почему снимок («милая, живая»)

---

## Восстановить

### Память (SQLite)

1. **Останови** Lia: Ctrl+C у `bun run dev` (или production server).
2. Восстанови из файла:

```bash
bun run kb:restore db/backup-sweet-era-2026-07-23.db
# подтверждение: YES
# или сразу: bun run kb:restore … --yes
```

Скрипт:

- кладёт safety-копию текущего `db/custom.db` → `db/pre-restore-….db`
- удаляет `custom.db-wal` / `custom.db-shm` (иначе подмешается старый журнал)
- подменяет live DB

3. Патчи схемы (без wipe) и запуск:

```bash
bun run db:push
bun run dev
```

Ручной вариант (если скрипта нет):

```bash
# сервер остановлен!
cp db/custom.db db/pre-restore-manual.db   # на всякий
rm -f db/custom.db-wal db/custom.db-shm
cp db/backup-sweet-era-2026-07-23.db db/custom.db
bun run db:push
bun run dev
```

### Модели Ollama

На GPU-машине (с установленным CLI `ollama`):

```bash
bun run ollama:restore ollama-backup-2026-07-22.json
# сначала посмотреть: bun run ollama:restore … --dry-run
```

Нужен интернет для `ollama pull`. Диалоги из этого JSON **не** восстанавливаются — только модели.

---

## Чего бэкап не вернёт один в один

- Удачный «тон» конкретного ответа (сэмплинг)
- Состояние VRAM / что monologue успел в тот вечер
- Несохранённые сообщения, если сервер упал mid-write без checkpoint

Бэкап БД возвращает **прожитое** (память, настройки, эпизоды).  
Ощущение «милая» потом снова зависит от модели, железа и разговора.

---

## Не делать

- Не коммитить `db/*.db` и `ollama-backup-*.json` в GitHub (личные данные / лишний шум).
- Не делать `bun run db:force-push` «для порядка» — это **wipe** БД.
- Не копировать `custom.db` через Finder/`cp` **пока** крутится сервер — лучше `kb:backup` (Online Backup API).

---

## Быстрый чеклист

**Сохранить:** `bun run kb:backup` → копия на Desktop → (опц.) `bun run ollama:backup`

**Вернуть:** стоп сервера → `bun run kb:restore <файл>.db` → `bun run db:push` → `bun run dev`
