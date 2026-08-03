# Plan: inference hardware pool (VRAM + RAM + NVMe)

> **Роль документа:** пресет и замеры **текущего** inference-хоста.  
> **План реализации (milestones M0–M6 для агента):** [`PLAN-LIA-BOTH-POLES.md`](./PLAN-LIA-BOTH-POLES.md).  
> Числа ниже (`14B`, `8–16k`, `16 GB`) — калибровка пула, не константы в коде.

**Status:** draft for owner review (2026-07-24); subordinated to both-poles plan  
**Goal:** не оставлять неиспользованной возможность задействовать всё железо под локальный Ollama / Lia — без бездумного компромисса «скорость любой ценой» и без экспериментального SSD-streaming в продукте.  
**Audience:** завтра перечитать свежим взглядом: где план верный, где автор (агент) ошибается или чрезмерно ограничивает.

Связанные файлы: `PLAN-LIA-BOTH-POLES.md`, `REMOTE-OLLAMA.md`, `src/lib/capability-profile.ts`, `src/lib/compute-budget.ts`, `src/lib/chat/context-budget.ts`, `src/lib/ollama.ts`, Settings → Model.

---

## 1. Позиция железа (контекст владельца)

| Ресурс | Роль в локальном LLM |
|--------|----------------------|
| RTX 5060 Ti **16 GB** | Основной compute + веса слоёв (полный GPU) |
| ~**20 GB** свободной DDR5 | Второй этаж: CPU/RAM layers (hybrid), когда модель > VRAM |
| Ryzen **9800X3D** | Быстрые CPU-слои при hybrid |
| Corsair **MP700 Pro** (NVMe) | Быстрый load / mmap / смена моделей — не «вторая VRAM» |

Ollama у Lia сейчас: remote `http://192.168.178.145:11434` (Windows host, путь `C:\Users\admin\.ollama\...`). UI на другой машине.

Публичные гайды 2026 по 5060 Ti 16 GB часто пишут «**14B ceiling**» — это потолок **полного GPU без spill**. Свободная DDR + X3D расширяют зону до **осознанного hybrid** (MoE / крупные веса), ценой tok/s на CPU-слоях.

---

## 2. Факты с твоего хоста (не теория)

Снято 2026-07-24 через `/api/tags`, `/api/show`, `/api/generate` + `/api/ps` на remote Ollama **0.32.1**.

| Модель | Params / quant | Файл | Замер residency |
|--------|----------------|------|-----------------|
| `qwen3:14b` | 14.8B Q4_K_M | 9.3 GB | ctx **8k** → **10.47 GB VRAM**, RAM 0 |
| `qwen3:14b` | | | ctx **16k** → **11.67 GB VRAM**, RAM 0 |
| `qwen3:14b` | | | ctx **~40k** (дефолт show) → **14.72 GB VRAM** + **~1.65 GB RAM** |
| `gpt-oss:20b` | 20.9B MoE MXFP4 | 13.8 GB | ctx **8k** → **12.74 GB VRAM**, RAM 0 |
| `qwen3.6:latest` | 36B MoE Q4 (256 exp, top-8) | 23.9 GB | ctx **4k** → **14.01 GB VRAM** + **~9.77 GB RAM** |

Текущие Settings Lia (на момент замера): chat/agent = `qwen3:14b`, embed = `nomic-embed-text-v2-moe`, Claude Code = `minimax-m2.5:cloud`.  
`/api/capability`: `vramGb: 0`, `vramSource: "inference-unknown"` — пул не задан (`LIA_INFERENCE_VRAM_GB` не используется → budget «comfortable» по оценке весов, без реального 16 GB).

**Не подтверждено в сессии:** точный `nvidia-smi` / имя GPU на Windows-боксе (только поведение Ollama + path). Если карта не 5060 Ti 16 GB — пересчитать пул, логика плана та же.

---

## 3. Что говорит внешний ландшафт (кратко)

- **Сток Ollama / llama.cpp:** слои **GPU ↔ system RAM**; веса часто **mmap** с NVMe. Перегруз RAM → page-in с диска → резкое падение tok/s (не «бесплатный SSD Offload»).
- **Исследования** DirectStorage / GPUDirect (напр. llm_upper, gdsllm): NVMe→VRAM DMA, быстрее load / узкие MoE-сценарии. **Не** встроены в Ollama, которым пользуется Lia.
- Гайды по 5060 Ti: sweet spot **Qwen3 14B Q4** full GPU; 32B dense на 16 GB — плохо; крупные MoE — только с spill.

Вывод для продукта: «задействовать всё железо» = **оркестрация пула VRAM+RAM+ролей моделей (+ быстрый swap с NVMe)**, а не встраивание экспериментального weight-streaming.

---

## 4. Как Lia ведёт себя сейчас (gap)

| Умеет | Не умеет / слабо |
|-------|------------------|
| Выбор chat / agent / embed / CC model | Не знает VRAM пул remote без `LIA_INFERENCE_VRAM_GB` |
| `num_ctx` на **chat** (tier-cap: plus до **65536**) | Нет `num_gpu` / `num_thread` / parallel |
| Warmup `keep_alive` (ограниченно на remote) | Agent **не** инжектит `num_ctx` |
| `compute-budget` / pressure | Pressure **observe/warn only** — не режет runtime (осознанно) |
| Secondary model в API/DB | **Нет UI** Secondary в Settings |
| | Нет роли «heavy / hybrid OK» vs «full GPU only» |
| | Нет политики: дневная модель в VRAM, heavy по запросу |

Итог gap: железо уже умеет hybrid (`qwen3.6` на хосте доказан); продукт **не заказывает** этот режим и легко **убивает запас VRAM раздутым ctx**.

---

## 5. Профит — куда имеет смысл лезть

Приоритет = качество и использование пула, не «максимальный blob любой ценой».

### P0 — дешёвый, сразу

1. **Задать `LIA_INFERENCE_VRAM_GB=16`** (или фактический VRAM) на машине с Lia UI / в `.env`.  
   Профит: capability/budget перестают врать; UI и логи опираются на реальный пул.
2. **Зафиксировать целевую матрицу ролей** (конфиг/Settings, без кода можно начать вручную):

| Роль | Модель (пример с текущего хоста) | Режим |
|------|----------------------------------|--------|
| Chat / Agent (день) | `qwen3:14b` или `gpt-oss:20b` | **Full GPU**, ctx **8–16k** |
| Heavy (сложные задачи) | `qwen3.6:latest` | **Hybrid** VRAM+RAM, ctx короткий (4–8k) |
| Embed | nomic… | маленький, рядом с дневной |
| Coding executor | Claude Code cloud (как сейчас) | вне локального пула |

3. **Не раздувать ctx «потому что модель умеет 40k/262k».**  
   Замер: 14B @ ~40k уже spill; @ 8–16k — чистый GPU. Профит: качество модели сохраняется, появляется headroom под embed / меньше thrash.

### P1 — продукт Lia (код)

4. **VRAM-aware `num_ctx`** (chat + agent): учитывать `LIA_INFERENCE_VRAM_GB` + оценку residency модели, а не только tier cap 32k/65k.  
   Профит: автоматический запас под full-GPU или осознанный hybrid.
5. **Secondary + Heavy в Settings UI** (secondary уже в API).  
   Профит: владелец явно включает «вторую/тяжёлую» модель = использование RAM/NVMe swap.
6. **Политика residency / warmup для remote:** pin дневной chat; heavy — `keep_alive` короткий / по запросу (NVMe ускоряет cold load).  
   Профит: 16 GB не делятся слепо на две крупные resident.
7. **Опционально `num_gpu` только для heavy-роли** (явный hybrid), иначе auto Ollama.  
   Профит: контроль, без глобальной ломки дефолтов.
8. Документировать в `REMOTE-OLLAMA.md` / README: пул = VRAM+RAM, NVMe = load, не compute.

### P2 — измерения / credibility

9. На Windows-хосте один раз: `nvidia-smi`, сверка VRAM; при желании tok/s A/B: `qwen3:14b` full vs `qwen3.6` hybrid на одном промпте.  
10. Smoke: Lia capability после `LIA_INFERENCE_VRAM_GB=16` показывает pool ≠ 0.

---

## 6. Куда не лезть (ограничения — спорные места помечены)

### Не лезть (сильная рекомендация)

| Тема | Почему |
|------|--------|
| **DirectStorage / GPUDirect / «SSD Offload» runtime внутри Lia** | Исследовательский стек; не в Ollama API продукта; поддержка адская; выигрыш в load/узких MoE, не замена VRAM для dense |
| **Гнать dense 32B+ «чтобы загрузить SSD»** | На 16 GB + умеренной RAM — либо плохой quant, либо disk thrash; качество/UX страдают |
| **Резать cognitive tier / maxSteps от VRAM pressure** | Уже сознательное правило Lia (observe/warn). Давление не должно молча душить агента |
| **Заменять cloud Claude Code локальным hybrid «ради железа»** | Coding path уже облачный; локальный пул — chat/ReAct/heavy, не обязательно CC |
| **Слепо max `num_ctx` = model context_length** | Доказанный VRAM killer на этом хосте |

### Спорно — завтра проверить, не «запрет навсегда»

| Утверждение в этом плане | Риск ошибки агента |
|--------------------------|-------------------|
| «14B/20B full GPU — база дня» | Может недооценивать `qwen3.6` hybrid на X3D+DDR для *качества* при приемлемой скорости |
| «Не встраивать SSD streaming» | Если появится стабильный Ollama-плагин / форк — пересмотреть; пока не продуктовый путь |
| «Secondary UI обязателен» | Можно обойтись env/API, если UI не приоритет |
| «Agent тоже должен слать num_ctx» | Возможно, agent path уже наследует другое; проверить перед правкой |
| «plus → 65k cap вреден» | Для remote 24 GB+ / другой карты — cap может быть ок; привязать к **пулу**, не выкидывать длинный ctx навсегда |

Если завтра покажется, что план **слишком ограничивает** — правильный вызов: «heavy hybrid по умолчанию для agent» или «длинный ctx важнее второй модели». Тогда переписать P0 матрицу, не тащить SSD runtime.

---

## 7. Критерий успеха

- [ ] Владелец явно видит: пул VRAM (и опционально RAM headroom) в capability / Settings.
- [ ] Дневной путь: модель **целиком в VRAM** при выбранном ctx (проверка `/api/ps`).
- [ ] Heavy путь: задокументирован и включаем; spill в RAM **ожидаем**, не accidental.
- [ ] NVMe используется как быстрый swap/load, не как основной tok/s path.
- [ ] Нет зависимости продукта от нестандартного SSD→GPU streaming.

---

## 8. Предлагаемый порядок работ (когда решишь кодить)

1. Env + док + ручная матрица моделей (P0) — без большого PR.  
2. VRAM-aware ctx + capability отображение пула.  
3. Settings: secondary / heavy + residency policy.  
4. Опционально `num_gpu` для heavy.  
5. Не начинать (1)–(4) с форков Ollama / DirectStorage.

---

## 9. Открытые вопросы владельцу (на пересмотр)

1. Дневной дефолт: остаёмся на `qwen3:14b` или пробуем `gpt-oss:20b` full GPU @ 8–16k как primary?  
2. Heavy (`qwen3.6`) — только вручную / отдельный слот, или agent auto-escalate?  
3. Нужен ли в UI индикатор «full GPU / hybrid / disk risk» по `/api/ps`?  
4. Где план ошибается или режет полезную амбицию — правь этот файл, не только код.

---

*Черновик составлен по замерам remote Ollama + обзору публичных источников 2026 и текущему коду Lia. Не является запретом экспериментов на хосте вне продукта.*
