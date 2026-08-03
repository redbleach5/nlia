# Удалённый Ollama без белого IP (работа → домашний GPU)

Lia запускается где угодно. Мозг (Ollama + GPU) может остаться дома.
Белый IP и проброс портов роутера **не нужны**.

## Рекомендация: Tailscale (бесплатно для себя)

Приватная сеть между твоими устройствами. Ollama не торчит в интернет.

### Один раз: домашний ПК с GPU

1. Установи [Tailscale](https://tailscale.com/download) и войди в аккаунт.
2. Ollama должна слушать не только localhost:

   ```bash
   # macOS / Linux (в том же терминале, что и serve)
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

   Windows: в системе задай переменную `OLLAMA_HOST=0.0.0.0`, перезапусти Ollama
   (или через «Переменные среды» → перезапуск приложения Ollama).

3. Узнай Tailscale IP этой машины:

   ```bash
   tailscale ip -4
   ```

   Пример: `100.64.1.23` — сохрани.

4. ПК не должен уходить в глубокий сон, пока ты на работе ждёшь ответы
   (иначе туннель жив, а GPU спит).

### Один раз: рабочий ноут

1. Тот же Tailscale, тот же аккаунт.
2. В репо: `git pull`, `bun install` при необходимости.
3. В `.env` (или **Настройки → Модель → Хост Ollama** в UI):

   ```bash
   OLLAMA_BASE_URL=http://100.64.1.23:11434
   LIA_INFERENCE_VRAM_GB=16
   ```

   Подставь свой IP из `tailscale ip -4` на GPU-ПК.
   `LIA_INFERENCE_VRAM_GB` = VRAM **домашней** карты (12 / 16 / …), не ноутбука.

4. Проверка с работы:

   ```bash
   curl -s http://100.64.1.23:11434/api/tags | head
   ```

   Если список моделей пришёл — можно `bun run dev` и чат.

### UI как источник правды

После первого сохранения в **Настройки → Модель** хост/модели живут в SQLite.
Строки `OLLAMA_*` в `.env` — bootstrap для пустой БД; для смены хоста удобнее UI
или очистка соответствующих ключей в Settings.

## Альтернативы (если Tailscale нельзя)

| Вариант | Плюсы | Минусы |
|---|---|---|
| **Cloudflare Tunnel** | Без клиента на «другой стороне» как у VPN | Ollama ближе к публичному HTTP; нужна осторожность с доступом |
| **ngrok free** | Быстро попробовать | Лимиты, меняющийся URL, не для постоянной работы |
| **LAN IP `192.168…`** | Просто дома/в офисе в одной сети | С работы через интернет **не** достучишься |

Для «утром на работу, GPU дома» бери **Tailscale**.

## Роли моделей и пул железа

Lia не привязана к одной SKU карты. Пул задаётся параметром; имена моделей — в Settings / `.env`.

| Роль | Назначение |
|------|------------|
| **chat** (day) | Companion-диалог, user-facing голос после агента / Claude Code |
| **agent** | ReAct plan/execute (tools); при CC off — coding loop |
| **secondary** | Лёгкие trivial-ходы (если задана) |
| **heavy** | Сложные / research / escalate — мозг, не обязательно «лицо» |
| **embed** | Память / KB embeddings |
| **claudeCode** | Coding executor (отдельный toggle); не companion prompt |

**Пул:** `LIA_INFERENCE_VRAM_GB` = VRAM inference-хоста (обязателен при remote).  
`LIA_INFERENCE_RAM_GB` — опциональный stub под будущий hybrid; сейчас не режет runtime.  
NVMe ускоряет **load / смену моделей**, не заменяет VRAM как compute.

Числа вроде «14B / 8–16k / 16 GB» — калибровка хоста в `PLAN-INFERENCE-HARDWARE.md`, не константы продукта.

**Residency (keep_alive):** day/chat — длинный keep_alive (warmup). Heavy после escalate — короткий / `0`, чтобы не держать тяжёлые веса вместо day.

## Что не путать

- **Удалённый Ollama** (`OLLAMA_BASE_URL` на Tailscale IP) — ноут говорит с домашним GPU. Это то, что нужно.
- **`LIA_ALLOW_REMOTE`** — открытие *API самой Lia* наружу. Для сценария выше **не** требуется: UI крутится на localhost ноутбука, наружу ходит только клиент Ollama по Tailscale.

## Чеклист на работе после `git pull`

- [ ] Tailscale online на ноуте и на домашнем ПК
- [ ] `OLLAMA_HOST=0.0.0.0` на GPU-ПК, Ollama запущена
- [ ] `OLLAMA_BASE_URL=http://<tailscale-ip>:11434`
- [ ] `LIA_INFERENCE_VRAM_GB` = ГБ домашней карты
- [ ] `curl …/api/tags` отвечает
- [ ] `bun run dev` → чат
