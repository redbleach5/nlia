#!/usr/bin/env bash
# ============================================================================
# Lia v2 — Полная диагностика системы
# ============================================================================
#
# Запуск:
#   cd Lia-v2
#   bash scripts/diagnose.sh
#
# Или с дополнительной детализацией:
#   bash scripts/diagnose.sh --verbose
#
# Лог сохраняется в: diagnose-YYYYMMDD-HHMMSS.log
# Краткий отчёт печатается в конце.
#
# Скрипт проверяет:
#   1. Окружение: node, bun, ollama, python3, git, curl
#   2. Ollama:健康, доступные модели, время отклика, генерация тестового промпта
#   3. Embedding: работает ли nomic-embed-text, размерность, скорость
#   4. БД: Prisma подключение, sqlite-vec extension, схемы таблиц
#   5. Проект: билд, dev-сервер, ключевые endpoints
#   6. Chat API: стриминг, время ответа, токены, эмоции
#   7. Agent API: создание задачи, PLAN, EXECUTE, SSE-стрим, input, cancel
#   8. VRM: наличие файла модели, размер, доступность по URL
#   9. Performance: LLM tokens/sec, embedding time, DB write speed
#  10. Финальный отчёт с рекомендациями
#
# Скрипт НЕ вносит изменения в систему — только чтение и тесты.
# Создаёт временный эпизод "diagnose-test" для тестов chat/agent, удаляет его в конце.

set -uo pipefail

# ============================================================================
# Конфигурация
# ============================================================================
VERBOSE=false
if [[ "${1:-}" == "--verbose" || "${1:-}" == "-v" ]]; then
  VERBOSE=true
fi

# Пути
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Timestamp для лог-файла
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$PROJECT_ROOT/diagnose-${TIMESTAMP}.log"

# Цвета (только если терминал поддерживает)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'  # No Color
else
  GREEN=''; RED=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; DIM=''; NC=''
fi

# Счётчики
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
SKIP_COUNT=0

# ============================================================================
# Helpers
# ============================================================================
log() {
  echo -e "$@" | tee -a "$LOG_FILE"
}

log_raw() {
  echo -e "$1" >> "$LOG_FILE"
}

section() {
  echo "" | tee -a "$LOG_FILE"
  log "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  log "${BLUE}${BOLD}  $1${NC}"
  log "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  log "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  log "  ${RED}✗${NC} $1"
  if [[ -n "${2:-}" ]]; then
    log "       ${DIM}${2}${NC}"
  fi
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  log "  ${YELLOW}⚠${NC} $1"
  if [[ -n "${2:-}" ]]; then
    log "       ${DIM}${2}${NC}"
  fi
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  log "  ${DIM}○ $1${NC}"
}

info() {
  log "  ${CYAN}→${NC} $1"
}

verbose() {
  if $VERBOSE; then
    log "  ${DIM}$1${NC}"
  fi
  log_raw "  [verbose] $1"
}

# Запуск команды с замером времени и захватом вывода.
# Использование: run_with_timing "label" command args...
# Вывод: три строки — duration_ms, exit_code, output (может быть многострочным).
# Чтение результата через хелперы ниже.
#
# ВАЖНО: используем head -n1 / tail -n +3 вместо sed -n '1p' — BSD sed на macOS
# некорректно обрабатывает многострочный ввод из переменных.
run_with_timing() {
  local label="$1"
  shift
  local start_ms end_ms duration_ms
  start_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  local output
  output=$("$@" 2>&1)
  local exit_code=$?
  end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  duration_ms=$((end_ms - start_ms))
  # Три строки: duration_ms | exit_code | output (многострочный)
  printf '%s\n%s\n' "$duration_ms" "$exit_code"
  printf '%s\n' "$output"
}

# Хелперы для извлечения полей из результата run_with_timing.
# Используем head/tail вместо sed — надёжнее на BSD (macOS).
get_duration() {
  printf '%s' "$1" | head -n 1
}
get_exit_code() {
  printf '%s' "$1" | head -n 2 | tail -n 1
}
get_output() {
  printf '%s' "$1" | tail -n +3
}

# ============================================================================
# Старт
# ============================================================================
log "${BOLD}Лия v2 — полная диагностика системы${NC}"
log "Время: $(date)"
log "Платформа: $(uname -s) $(uname -r) $(uname -m)"
log "Лог: $LOG_FILE"
log "Verbose: $VERBOSE"
log ""

# ============================================================================
# 1. Окружение
# ============================================================================
section "1. Окружение"

# Node
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  pass "Node.js: $NODE_VERSION"
else
  fail "Node.js не найден" "Установи: https://nodejs.org/"
fi

# Bun
if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version)
  pass "Bun: $BUN_VERSION"
else
  warn "Bun не найден" "Можно использовать npm, но рекомендуется bun"
fi

# Python3
if command -v python3 &>/dev/null; then
  PY_VERSION=$(python3 --version 2>&1)
  pass "Python: $PY_VERSION"
else
  warn "Python3 не найден" "Нужен для RL sidecar (опционально)"
fi

# Git
if command -v git &>/dev/null; then
  GIT_VERSION=$(git --version)
  pass "Git: $GIT_VERSION"
else
  fail "Git не найден"
fi

# Curl
if command -v curl &>/dev/null; then
  pass "curl: $(curl --version | head -1 | awk '{print $1, $2}')"
else
  fail "curl не найден"
fi

# Ollama
if command -v ollama &>/dev/null; then
  OLLAMA_VERSION_OUTPUT=$(ollama --version 2>&1)
  # Проверяем что ollama CLI действительно работает, а не просто установлен.
  # На macOS бывает что CLI есть, но сам ollama-сервис не запущен — тогда
  # 'ollama --version' выдаёт "Warning: could not connect to a running Ollama instance".
  if echo "$OLLAMA_VERSION_OUTPUT" | grep -qi "could not connect\|warning"; then
    warn "Ollama CLI установлен, но сервис не запущен" "Запусти Ollama.app или 'ollama serve' в отдельном терминале"
    info "Вывод ollama --version: $(echo "$OLLAMA_VERSION_OUTPUT" | head -1)"
  else
    pass "Ollama CLI: $(echo "$OLLAMA_VERSION_OUTPUT" | head -1)"
  fi
else
  warn "Ollama CLI не в PATH" "Возможно установлен в /usr/local/bin или ~/Applications"
  # Проверяем стандартные пути на macOS
  for path in /usr/local/bin/ollama /opt/homebrew/bin/ollama "$HOME/Applications/Ollama.app/Contents/MacOS/ollama" /Applications/Ollama.app/Contents/MacOS/ollama; do
    if [[ -x "$path" ]]; then
      info "Ollama найден в нестандартном пути: $path"
      OLLAMA_BIN="$path"
      break
    fi
  done
fi

# Homebrew (на macOS)
if [[ "$(uname -s)" == "Darwin" ]]; then
  if command -v brew &>/dev/null; then
    pass "Homebrew установлен"
  else
    warn "Homebrew не найден" "Рекомендуется для установки зависимостей"
  fi
fi

# ============================================================================
# 2. Ollama
# ============================================================================
section "2. Ollama"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
info "Base URL: $OLLAMA_BASE_URL"

# Проверка доступности
result=$(run_with_timing "ollama_health" curl -s -m 5 "$OLLAMA_BASE_URL/api/tags")
duration_ms=$(get_duration "$result")
exit_code=$(get_exit_code "$result")
output=$(get_output "$result")

if [[ $exit_code -eq 0 ]] && echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'models' in d else 1)" 2>/dev/null; then
  MODELS_COUNT=$(echo "$output" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('models', [])))")
  pass "Ollama доступен ($duration_ms ms, моделей: $MODELS_COUNT)"
  verbose "$(echo "$output" | head -c 500)"
else
  fail "Ollama недоступен на $OLLAMA_BASE_URL" "Запусти 'ollama serve' или проверь URL в .env"
  # Пропускаем остальные тесты Ollama
  skip "Все остальные тесты Ollama пропущены"
  section_skip_ollama=true
fi

if [[ "${section_skip_ollama:-false}" != "true" ]]; then
  # Список моделей
  info "Доступные модели:"
  echo "$output" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('models', []):
    name = m.get('name', '?')
    size_mb = m.get('size', 0) / 1024 / 1024
    print(f'    {name} ({size_mb:.0f} MB)')
" | tee -a "$LOG_FILE"

  # Проверка chat-модели
  CHAT_MODEL=$(grep OLLAMA_MODEL "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [[ -z "$CHAT_MODEL" ]]; then
    CHAT_MODEL="qwen2.5:7b"
  fi
  info "Chat-модель (из .env): $CHAT_MODEL"

  if echo "$output" | python3 -c "import json,sys; models=[m['name'] for m in json.load(sys.stdin).get('models',[])]; exit(0 if '$CHAT_MODEL' in models else 1)" 2>/dev/null; then
    pass "Chat-модель '$CHAT_MODEL' доступна"
  else
    # Попробуем partial match
    if echo "$output" | python3 -c "import json,sys; models=[m['name'] for m in json.load(sys.stdin).get('models',[])]; exit(0 if any('$CHAT_MODEL'.split(':')[0] in m for m in models) else 1)" 2>/dev/null; then
      warn "Chat-модель '$CHAT_MODEL' не точное совпадение" "Lia будет использовать partial match"
    else
      fail "Chat-модель '$CHAT_MODEL' не найдена в Ollama" "Скачай: ollama pull $CHAT_MODEL"
    fi
  fi

  # Проверка embed-модели
  EMBED_MODEL=$(grep OLLAMA_EMBED_MODEL "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [[ -z "$EMBED_MODEL" ]]; then
    EMBED_MODEL="nomic-embed-text"
  fi
  info "Embed-модель (из .env): $EMBED_MODEL"

  if echo "$output" | python3 -c "import json,sys; models=[m['name'] for m in json.load(sys.stdin).get('models',[])]; exit(0 if '$EMBED_MODEL' in models else 1)" 2>/dev/null; then
    pass "Embed-модель '$EMBED_MODEL' доступна"
  else
    fail "Embed-модель '$EMBED_MODEL' не найдена" "Скачай: ollama pull $EMBED_MODEL"
  fi
fi

# ============================================================================
# 3. Тест генерации LLM (если Ollama доступен)
# ============================================================================
if [[ "${section_skip_ollama:-false}" != "true" ]]; then
  section "3. Тест генерации LLM"

  info "Тестовый промпт: 'Назови столицу Франции. Один словом.'"

  result=$(run_with_timing "llm_generate" curl -s -m 120 \
    "$OLLAMA_BASE_URL/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$CHAT_MODEL\",\"prompt\":\"Назови столицу Франции. Одно слово.\",\"stream\":false}")
  duration_ms=$(get_duration "$result")
  exit_code=$(get_exit_code "$result")
  output=$(get_output "$result")

  if [[ $exit_code -eq 0 ]]; then
    RESPONSE=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin).get('response','')[:200])" 2>/dev/null)
    EVAL_COUNT=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin).get('eval_count', 0))" 2>/dev/null)
    EVAL_DURATION=$(echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin).get('eval_duration', 1); print(d/1e9)" 2>/dev/null)

    if [[ -n "$RESPONSE" ]]; then
      pass "LLM ответила ($duration_ms ms, $EVAL_COUNT токенов)"
      info "Ответ: $RESPONSE"
      if [[ $(echo "$EVAL_DURATION > 0" | bc -l 2>/dev/null) -eq 1 ]] && [[ $EVAL_COUNT -gt 0 ]]; then
        TOKENS_PER_SEC=$(python3 -c "print(f'{$EVAL_COUNT / $EVAL_DURATION:.1f}')" 2>/dev/null)
        info "Скорость: $TOKENS_PER_SEC токенов/сек"

        # Проверка адекватности скорости
        if (( $(echo "$TOKENS_PER_SEC > 5" | bc -l 2>/dev/null || echo 0) )); then
          pass "Скорость генерации приемлемая (>5 tok/s)"
        elif (( $(echo "$TOKENS_PER_SEC > 1" | bc -l 2>/dev/null || echo 0) )); then
          warn "Скорость генерации низкая ($TOKENS_PER_SEC tok/s)" "Большие задачи могут таймаутить. Увеличь LIA_LLM_TIMEOUT_MS в .env"
        else
          fail "Скорость генерации критически низкая ($TOKENS_PER_SEC tok/s)" "LLM слишком медленная. Попробуй модель поменьше (qwen2.5:3b)"
        fi
      fi
    else
      fail "LLM вернул пустой ответ" "$output"
    fi
  else
    fail "LLM не ответил за 120 секунд" "Возможно модель слишком большая или железо слабое"
  fi
fi

# ============================================================================
# 4. Тест embedding (если Ollama доступен)
# ============================================================================
if [[ "${section_skip_ollama:-false}" != "true" ]]; then
  section "4. Тест embedding"

  info "Тестовый текст: 'Привет, как дела?'"

  result=$(run_with_timing "embed_generate" curl -s -m 60 \
    "$OLLAMA_BASE_URL/api/embed" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"Привет, как дела?\"}")
  duration_ms=$(get_duration "$result")
  exit_code=$(get_exit_code "$result")
  output=$(get_output "$result")

  if [[ $exit_code -eq 0 ]]; then
    DIMS=$(echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('embeddings',d.get('embedding',[])); print(len(v[0]) if v else 0)" 2>/dev/null)
    if [[ -n "$DIMS" ]] && [[ $DIMS -gt 0 ]]; then
      pass "Embedding работает ($duration_ms ms, размерность: $DIMS)"

      if [[ $duration_ms -gt 10000 ]]; then
        warn "Embedding очень медленный ($duration_ms ms)" "Это норма для nomic-embed на CPU, но замедляет агентский режим"
      elif [[ $duration_ms -gt 3000 ]]; then
        info "Embedding медленный ($duration_ms ms) — нормально для небольших моделей"
      fi
    else
      fail "Embedding вернул пустой вектор" "$output"
    fi
  else
    fail "Embedding не ответил за 60 секунд"
  fi
fi

# ============================================================================
# 5. БД и проект
# ============================================================================
section "5. Проект и БД"

# Проверка .env
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  pass ".env найден"
  verbose "$(cat "$PROJECT_ROOT/.env" | grep -v '^#' | grep -v '^$' | head -10)"

  # Проверка критичных переменных
  ENV_CHAT_MODEL=$(grep "^OLLAMA_MODEL=" "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [[ -z "$ENV_CHAT_MODEL" ]]; then
    warn "OLLAMA_MODEL пустой в .env" "Будет использован default 'qwen2.5:7b' или модель из БД. Рекомендуется задать явно."
  fi

  ENV_BASE_URL=$(grep "^OLLAMA_BASE_URL=" "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [[ -z "$ENV_BASE_URL" ]]; then
    warn "OLLAMA_BASE_URL пустой в .env" "Будет использован default 'http://127.0.0.1:11434'"
  fi
else
  fail ".env не найден" "Скопируй: cp .env.example .env"
fi

# Проверка RAM — особенно важно для Mac с 8GB
info "Проверяю оперативную память..."
if [[ "$(uname -s)" == "Darwin" ]]; then
  RAM_GB=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Memory" | awk -F': ' '{print $2}' | grep -oE '[0-9]+' | head -1)
  if [[ -n "$RAM_GB" ]]; then
    info "RAM: ${RAM_GB}GB"
    if [[ $RAM_GB -lt 8 ]]; then
      fail "RAM ${RAM_GB}GB — слишком мало" "Нужно минимум 8GB для 3B моделей, 16GB для 7B, 32GB для 13B"
    elif [[ $RAM_GB -lt 16 ]]; then
      warn "RAM ${RAM_GB}GB — мало для 7B моделей" "Используй qwen2.5:3b или phi3:mini. 7B модели могут тормозить."
    else
      pass "RAM ${RAM_GB}GB — достаточно для большинства моделей"
    fi
  fi
else
  # Linux
  RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
  if [[ -n "$RAM_KB" ]]; then
    RAM_GB=$((RAM_KB / 1024 / 1024))
    info "RAM: ${RAM_GB}GB"
    if [[ $RAM_GB -lt 8 ]]; then
      warn "RAM ${RAM_GB}GB — мало для 7B моделей"
    fi
  fi
fi

# Проверка node_modules
if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
  pass "node_modules установлен"
else
  fail "node_modules не найден" "Запусти: bun install"
fi

# Проверка Prisma
if [[ -d "$PROJECT_ROOT/node_modules/@prisma" ]]; then
  pass "Prisma установлен"

  # Проверка сгенерированного клиента
  if [[ -f "$PROJECT_ROOT/node_modules/@prisma/client/index.js" ]]; then
    pass "Prisma client сгенерирован"
  else
    warn "Prisma client не сгенерирован" "Запусти: bunx prisma generate"
  fi
else
  fail "Prisma не установлен"
fi

# Проверка БД файла
# DB_PATH is the raw value from .env (e.g. "../db/custom.db"). Prisma resolves
# it relative to prisma/, better-sqlite3 strips leading "../" and resolves
# relative to project root. Both land on <root>/db/custom.db when the URL is
# file:../db/custom.db. Here we mirror the better-sqlite3 resolution so the
# "file exists" check looks at the same file the app actually opens.
DB_PATH=$(grep DATABASE_URL "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | sed 's|^file:||')
if [[ -z "$DB_PATH" ]]; then
  DB_PATH="./db/custom.db"
fi
APP_DB_REL="$DB_PATH"
while [[ "$APP_DB_REL" == ../* || "$APP_DB_REL" == ..\\* ]]; do
  APP_DB_REL="${APP_DB_REL:3}"
done
ABS_DB_PATH=$(cd "$PROJECT_ROOT" && realpath "$APP_DB_REL" 2>/dev/null || echo "$PROJECT_ROOT/$APP_DB_REL")

if [[ -f "$ABS_DB_PATH" ]]; then
  DB_SIZE=$(du -h "$ABS_DB_PATH" | cut -f1)
  pass "БД существует ($DB_SIZE)"
else
  warn "БД не существует" "Запусти: bun run db:push"
fi

# ── DB path consistency check (audit §2.1) ──
# Prisma resolves DATABASE_URL relative to prisma/schema.prisma (one level
# below project root). better-sqlite3 (via src/lib/paths.ts) resolves it
# relative to PROJECT_ROOT (project root), but strips a leading "../" first
# because that prefix exists for Prisma's sake (it lives one dir below root).
# For both to open the SAME file, DATABASE_URL must use "../" prefix —
# e.g. file:../db/custom.db resolves to <root>/db/custom.db in both layers.
info "Проверяю согласованность пути к БД (Prisma vs better-sqlite3)..."
PRISMA_DB_PATH=$(cd "$PROJECT_ROOT/prisma" && realpath "$DB_PATH" 2>/dev/null || echo "$PROJECT_ROOT/prisma/$DB_PATH")
# APP_DB_PATH already computed above (mirrors src/lib/paths.ts behavior).

if [[ "$PRISMA_DB_PATH" == "$ABS_DB_PATH" ]]; then
  pass "Путь к БД согласован: $ABS_DB_PATH"
else
  fail "Расхождение путей БД (критично!)" \
    "Prisma открывает: $PRISMA_DB_PATH
       better-sqlite3 открывает: $ABS_DB_PATH
       Используй DATABASE_URL=file:../db/custom.db в .env, затем удали обе базы и запусти bun run db:push.
       Без фикса VectorMemory и RLExperience данные пишутся в разные файлы."
fi

# ── DB schema completeness check ──
# After DB file exists, verify all Prisma-managed tables are present.
# If the better-sqlite3 layer opened an empty/wrong file (older bug), only
# vec_virtual + VectorMemory + EmotionalMemory would exist, and queries
# against Episode / RLExperience would silently return empty results.
#
# KB tables (Source/Chunk/Ticket) are optional: they were added in KB Phase 1
# and may not exist on older databases. We list them separately and only warn
# (not fail) if missing — `bun run db:push` will create them.
if [[ -f "$ABS_DB_PATH" ]]; then
  info "Проверяю наличие всех таблиц Prisma в БД..."
  REQUIRED_TABLES="Episode Message GlobalFact EpisodeFact VectorMemory EmotionalMemory AgentTask RlModelVersion RLExperience Setting"
  KB_TABLES="Source Chunk"
  MISSING_TABLES=""
  MISSING_KB_TABLES=""
  for tbl in $REQUIRED_TABLES; do
    if ! NODE_PATH="$PROJECT_ROOT/node_modules" node -e "
      const Database = require('better-sqlite3');
      const db = new Database('$ABS_DB_PATH', { readonly: true });
      const row = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name = ?\").get('$tbl');
      db.close();
      process.exit(row ? 0 : 1);
    " 2>/dev/null; then
      MISSING_TABLES="$MISSING_TABLES $tbl"
    fi
  done
  # KB tables — soft check
  for tbl in $KB_TABLES; do
    if ! NODE_PATH="$PROJECT_ROOT/node_modules" node -e "
      const Database = require('better-sqlite3');
      const db = new Database('$ABS_DB_PATH', { readonly: true });
      const row = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name = ?\").get('$tbl');
      db.close();
      process.exit(row ? 0 : 1);
    " 2>/dev/null; then
      MISSING_KB_TABLES="$MISSING_KB_TABLES $tbl"
    fi
  done
  if [[ -z "$MISSING_TABLES" ]]; then
    pass "Все 10 базовых таблиц Prisma присутствуют в БД"
  else
    fail "В БД отсутствуют таблицы:$MISSING_TABLES" \
      "Возможно БД создана лучше-sqlite3 без Prisma schema. Удали $ABS_DB_PATH и запусти bun run db:push."
  fi
  if [[ -z "$MISSING_KB_TABLES" ]]; then
    pass "KB таблицы Source и Chunk присутствуют"
  else
    warn "В БД отсутствуют KB таблицы:$MISSING_KB_TABLES" \
      "Knowledge Base не будет работать до запуска bun run db:push (KB Phase 1+)."
  fi
fi

# Проверка sqlite-vec extension
SQLITE_VEC_DIR=$(ls -d "$PROJECT_ROOT"/node_modules/sqlite-vec-* 2>/dev/null | head -1)
if [[ -n "$SQLITE_VEC_DIR" ]]; then
  pass "sqlite-vec пакет установлен: $(basename $SQLITE_VEC_DIR)"
  if [[ -f "$SQLITE_VEC_DIR/vec0.so" ]] || [[ -f "$SQLITE_VEC_DIR/vec0.dylib" ]] || [[ -f "$SQLITE_VEC_DIR/vec0.dll" ]]; then
    pass "sqlite-vec native binary найден"
  else
    fail "sqlite-vec native binary не найден" "Переустанови: rm -rf node_modules && bun install"
  fi
else
  fail "sqlite-vec пакет не установлен"
fi

# Проверка git status
cd "$PROJECT_ROOT"
if git rev-parse --git-dir &>/dev/null; then
  GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  GIT_COMMIT=$(git rev-parse --short HEAD)
  pass "Git: ветка $GIT_BRANCH, коммит $GIT_COMMIT"

  if [[ -n "$(git status --porcelain)" ]]; then
    CHANGES=$(git status --porcelain | wc -l | tr -d ' ')
    warn "Есть несохранённые изменения ($CHANGES файлов)" "Сделай commit перед диагностикой для воспроизводимости"
  fi
else
  warn "Не git репозиторий"
fi

# Проверка прав на запись в ключевые папки
info "Проверяю права на запись..."
for dir in db download public/models; do
  if [[ -d "$PROJECT_ROOT/$dir" ]]; then
    if [[ -w "$PROJECT_ROOT/$dir" ]]; then
      pass "Папка $dir доступна для записи"
    else
      fail "Папка $dir недоступна для записи" "chmod +w $dir"
    fi
  else
    # Пробуем создать
    if mkdir -p "$PROJECT_ROOT/$dir" 2>/dev/null; then
      pass "Папка $dir создана"
    else
      fail "Не могу создать папку $dir"
    fi
  fi
done

# Проверка свободного места на диске
DISK_FREE=$(df -h "$PROJECT_ROOT" 2>/dev/null | tail -1 | awk '{print $4}')
if [[ -n "$DISK_FREE" ]]; then
  info "Свободное место на диске: $DISK_FREE"
  # Если меньше 1GB — предупреждаем
  DISK_FREE_MB=$(df -m "$PROJECT_ROOT" 2>/dev/null | tail -1 | awk '{print $4}')
  if [[ -n "$DISK_FREE_MB" ]] && [[ $DISK_FREE_MB -lt 1024 ]]; then
    warn "Мало свободного места (${DISK_FREE_MB}MB)" "Может вызвать ошибки записи в БД или логи"
  fi
fi

# Проверка что порт 3000 свободен
if command -v lsof &>/dev/null; then
  PORT_3000=$(lsof -ti:3000 2>/dev/null | head -1)
  if [[ -z "$PORT_3000" ]]; then
    pass "Порт 3000 свободен"
  else
    warn "Порт 3000 занят (PID: $PORT_3000)" "Завершу этот процесс перед запуском dev-сервера"
  fi
fi

# ============================================================================
# 6. Сборка проекта
# ============================================================================
section "6. Сборка проекта"

# Удаляем .next чтобы форсировать реальную сборку, а не cached
if [[ -d "$PROJECT_ROOT/.next" ]]; then
  info "Очищаю кэш .next для чистой сборки..."
  rm -rf "$PROJECT_ROOT/.next"
fi

info "Запускаю 'bun run build' (это может занять 1-2 минуты)..."

result=$(run_with_timing "build" bash -c "bun run build 2>&1")
duration_ms=$(get_duration "$result")
exit_code=$(get_exit_code "$result")
output=$(get_output "$result")
duration_sec=$((duration_ms / 1000))

if [[ $exit_code -eq 0 ]]; then
  pass "Сборка успешна (${duration_sec}s)"
else
  fail "Сборка провалилась" "См. последние строки вывода:"
  echo "$output" | tail -20 | sed 's/^/       /' | tee -a "$LOG_FILE"
fi

# ============================================================================
# 7. Dev-сервер и API endpoints
# ============================================================================
section "7. Dev-сервер и API"

# Запускаем dev-сервер в фоне
info "Запускаю dev-сервер в фоне..."

# Убиваем предыдущие процессы на порту 3000
if command -v lsof &>/dev/null; then
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
fi

DEV_PORT=3000
DEV_LOG_FILE="$PROJECT_ROOT/diagnose-dev.log"
rm -f "$DEV_LOG_FILE"

# Запускаем dev-сервер
(bun run dev > "$DEV_LOG_FILE" 2>&1 &) 2>/dev/null || (npm run dev > "$DEV_LOG_FILE" 2>&1 &) 2>/dev/null
# PID в фоне не нужен — мы убиваем по порту через lsof в конце
DEV_PID=""

# Ждём готовности
info "Жду запуска dev-сервера (до 60 секунд)..."
DEV_READY=false
for i in $(seq 1 60); do
  if curl -s -m 1 "http://localhost:$DEV_PORT/api/health" &>/dev/null; then
    DEV_READY=true
    info "Dev-сервер готов после ${i}s"
    break
  fi
  sleep 1
done

if ! $DEV_READY; then
  fail "Dev-сервер не запустился за 60 секунд"
  echo "$DEV_LOG_FILE последние 30 строк:" | tee -a "$LOG_FILE"
  tail -30 "$DEV_LOG_FILE" | sed 's/^/       /' | tee -a "$LOG_FILE"
  # Не выходим — продолжаем другие тесты
  section_skip_api=true
else
  pass "Dev-сервер запущен на порту $DEV_PORT"

  # Проверка health endpoint
  result=$(run_with_timing "health" curl -s -m 5 "http://localhost:$DEV_PORT/api/health")
  duration_ms=$(get_duration "$result")
  exit_code=$(get_exit_code "$result")
  output=$(get_output "$result")

  if [[ $exit_code -eq 0 ]]; then
    OLLAMA_OK=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
    if [[ "$OLLAMA_OK" == "True" ]]; then
      pass "/api/health: Ollama OK ($duration_ms ms)"
    else
      warn "/api/health: Ollama недоступен через сервер" "Проверь OLLAMA_BASE_URL в .env"
    fi
  else
    fail "/api/health не ответил"
  fi

  # Проверка settings endpoint
  result=$(run_with_timing "settings" curl -s -m 5 "http://localhost:$DEV_PORT/api/settings")
  duration_ms=$(get_duration "$result")
  exit_code=$(get_exit_code "$result")
  if [[ $exit_code -eq 0 ]]; then
    pass "/api/settings отвечает ($duration_ms ms)"
  else
    fail "/api/settings не ответил"
  fi

  # Проверка episodes endpoint
  result=$(run_with_timing "episodes" curl -s -m 5 "http://localhost:$DEV_PORT/api/episodes")
  duration_ms=$(get_duration "$result")
  exit_code=$(get_exit_code "$result")
  if [[ $exit_code -eq 0 ]]; then
    pass "/api/episodes отвечает ($duration_ms ms)"
  else
    fail "/api/episodes не ответил"
  fi
fi

# ============================================================================
# 8. Chat API (если dev-сервер работает и Ollama доступен)
# ============================================================================
if [[ "${section_skip_api:-false}" != "true" ]] && [[ "${section_skip_ollama:-false}" != "true" ]]; then
  section "8. Chat API"

  # Создаём тестовый эпизод
  info "Создаю тестовый эпизод..."
  result=$(curl -s -m 5 -X POST "http://localhost:$DEV_PORT/api/episodes" \
    -H "Content-Type: application/json" \
    -d '{"title":"diagnose-test"}')
  EPISODE_ID=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('episode',{}).get('id',''))" 2>/dev/null)

  if [[ -n "$EPISODE_ID" ]]; then
    pass "Тестовый эпизод создан: $EPISODE_ID"
  else
    fail "Не удалось создать эпизод" "$result"
    section_skip_chat=true
  fi

  if [[ "${section_skip_chat:-false}" != "true" ]]; then
    info "Отправляю тестовое сообщение: 'Привет!'"

    # Замеряем время до первого чанка и общее время
    start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

    result=$(curl -s -m 120 -X POST "http://localhost:$DEV_PORT/api/chat" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"Привет! Как дела?\",\"episodeId\":\"$EPISODE_ID\",\"mode\":\"fast\"}" \
      -w "\n---HTTP_CODE:%{http_code}---" 2>&1)

    end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
    duration_ms=$((end_ms - start_ms))
    duration_sec=$((duration_ms / 1000))

    HTTP_CODE=$(echo "$result" | grep -o 'HTTP_CODE:[0-9]*' | cut -d: -f2)
    BODY=$(echo "$result" | sed 's/---HTTP_CODE:[0-9]*---//')

    if [[ "$HTTP_CODE" == "200" ]]; then
      RESPONSE_LEN=${#BODY}
      pass "Chat ответил за ${duration_sec}s ($RESPONSE_LEN символов)"
      info "Ответ: $(echo "$BODY" | head -c 200)"

      if [[ $duration_sec -gt 60 ]]; then
        warn "Chat отвечал слишком долго (${duration_sec}s)" "Увеличь LIA_LLM_TIMEOUT_MS в .env или используй модель поменьше"
      fi

      if [[ $RESPONSE_LEN -lt 10 ]]; then
        warn "Ответ очень короткий ($RESPONSE_LEN символов)" "Возможно LLM не дописала"
      fi
    elif [[ "$HTTP_CODE" == "503" ]]; then
      ERR_MSG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
      fail "Chat вернул 503: $ERR_MSG"
    else
      fail "Chat вернул HTTP $HTTP_CODE" "$(echo "$BODY" | head -c 200)"
    fi
  fi
fi

# ============================================================================
# 9. Agent API
# ============================================================================
if [[ "${section_skip_api:-false}" != "true" ]] && [[ "${section_skip_chat:-false}" != "true" ]] && [[ -n "${EPISODE_ID:-}" ]]; then
  section "9. Agent API"

  info "Создаю агентскую задачу..."

  result=$(curl -s -m 10 -X POST "http://localhost:$DEV_PORT/api/agent" \
    -H "Content-Type: application/json" \
    -d "{\"episodeId\":\"$EPISODE_ID\",\"goal\":\"Напиши hello world на Python\",\"autoStart\":true,\"maxSteps\":3}")
  TASK_ID=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null)

  if [[ -n "$TASK_ID" ]]; then
    pass "Агентская задача создана: $TASK_ID"

    # Ждём и проверяем статус
    info "Жду 30 секунд для выполнения..."
    sleep 30

    result=$(curl -s -m 5 "http://localhost:$DEV_PORT/api/agent/$TASK_ID")
    TASK_STATUS=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null)
    TASK_ERROR=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('task',{}).get('error','') or '')" 2>/dev/null)

    info "Статус: $TASK_STATUS"

    case "$TASK_STATUS" in
      done)
        pass "Агент завершил задачу"
        RESULT_PREVIEW=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('task',{}).get('resultSummary','')[:200])" 2>/dev/null)
        info "Результат: $RESULT_PREVIEW"
        ;;
      failed)
        fail "Агент провалился" "$TASK_ERROR"
        ;;
      planning|executing|synthesizing)
        warn "Агент ещё работает (статус: $TASK_STATUS)" "Возможно, LLM медленный. Жду ещё 30 секунд..."
        sleep 30
        result=$(curl -s -m 5 "http://localhost:$DEV_PORT/api/agent/$TASK_ID")
        TASK_STATUS=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null)
        info "Статус после ещё 30с: $TASK_STATUS"
        if [[ "$TASK_STATUS" == "done" ]]; then
          pass "Агент завершил задачу (после ожидания)"
        elif [[ "$TASK_STATUS" == "failed" ]]; then
          fail "Агент провалился (после ожидания)"
        else
          warn "Агент всё ещё работает" "Возможно, нужны большие таймауты или более быстрая модель"
        fi
        ;;
      waiting_input)
        warn "Агент ждёт ответа пользователя" "Это может быть нормально для интерактивных задач"
        # Отменяем задачу
        curl -s -m 5 -X POST "http://localhost:$DEV_PORT/api/agent/$TASK_ID/cancel" &>/dev/null
        info "Задача отменена"
        ;;
      *)
        warn "Неизвестный статус: $TASK_STATUS"
        ;;
    esac

    # Проверяем SSE endpoint
    info "Проверяю SSE endpoint..."
    SSE_RESULT=$(curl -s -m 3 "http://localhost:$DEV_PORT/api/agent/$TASK_ID/stream" 2>&1 | head -5)
    if echo "$SSE_RESULT" | grep -q "event:" || echo "$SSE_RESULT" | grep -q "data:"; then
      pass "SSE endpoint работает"
    else
      warn "SSE endpoint не вернул события" "Возможно задача уже завершена"
    fi
  else
    fail "Не удалось создать агентскую задачу" "$result"
  fi
fi

# ============================================================================
# 10. VRM аватар
# ============================================================================
section "10. VRM аватар"

VRM_DIR="$PROJECT_ROOT/public/models"
if [[ -d "$VRM_DIR" ]]; then
  VRM_FILES=$(ls "$VRM_DIR"/*.vrm 2>/dev/null)
  if [[ -n "$VRM_FILES" ]]; then
    for vrm in $VRM_FILES; do
      VRM_SIZE=$(du -h "$vrm" | cut -f1)
      pass "VRM файл: $(basename $vrm) ($VRM_SIZE)"
    done
  else
    warn "VRM файлы не найдены в public/models/" "Скачай через Настройки → Внешний вид → Скачать готовую"
  fi
else
  warn "Папка public/models не существует" "VRM будет автоматически создан при первой загрузке"
fi

# Проверка через API (если dev-сервер работает)
if [[ "${section_skip_api:-false}" != "true" ]]; then
  result=$(curl -s -m 5 "http://localhost:$DEV_PORT/api/settings")
  ACTIVE_VRM=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('activeVrm','') or '')" 2>/dev/null)
  AVATAR_MODE=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('avatarMode','3d'))" 2>/dev/null)

  info "Avatar mode: $AVATAR_MODE"
  if [[ -n "$ACTIVE_VRM" ]]; then
    info "Active VRM: $ACTIVE_VRM"

    # Проверяем доступность файла
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://localhost:$DEV_PORT$ACTIVE_VRM")
    if [[ "$HTTP_CODE" == "200" ]]; then
      pass "VRM файл доступен по URL"
    else
      fail "VRM файл недоступен по URL (HTTP $HTTP_CODE)" "Файл: $ACTIVE_VRM"
    fi
  else
    warn "VRM не выбран" "Колонка аватара покажет placeholder без модели"
  fi
fi

# ============================================================================
# 11. Очистка
# ============================================================================
if [[ "${section_skip_api:-false}" != "true" ]] && [[ -n "${EPISODE_ID:-}" ]]; then
  section "11. Очистка"

  info "Удаляю тестовый эпизод..."
  curl -s -m 5 -X DELETE "http://localhost:$DEV_PORT/api/episodes/$EPISODE_ID" &>/dev/null
  pass "Тестовый эпизод удалён"
fi

# Останавливаем dev-сервер — всегда, если он был запущен
if [[ -f "$DEV_LOG_FILE" ]]; then
  info "Останавливаю dev-сервер..."
  # Ищем и убиваем процессы на порту 3000
  if command -v lsof &>/dev/null; then
    lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi
  # Также pkill по имени процесса
  pkill -9 -f "next-server" 2>/dev/null || true
  pkill -9 -f "next dev" 2>/dev/null || true
  pkill -9 -f "bun run dev" 2>/dev/null || true
  sleep 2
  pass "Dev-сервер остановлен"

  # Анализируем dev-лог на ошибки
  info "Анализирую dev-лог на ошибки..."
  # Исключаем строку о SIGKILL — это мы сами убили dev-сервер
  ERRORS_COUNT=$(grep -E "Error|ERROR|Failed|FAIL" "$DEV_LOG_FILE" 2>/dev/null | grep -v "terminated by signal" | grep -v "Bail out to client-side" | wc -l | tr -d ' ')
  ERRORS_COUNT=${ERRORS_COUNT:-0}
  WARNINGS_COUNT=$(grep -cE "WARN" "$DEV_LOG_FILE" 2>/dev/null)
  WARNINGS_COUNT=${WARNINGS_COUNT:-0}
  info "Dev-лог: $ERRORS_COUNT ошибок, $WARNINGS_COUNT предупреждений"

  if [[ $ERRORS_COUNT -gt 0 ]]; then
    warn "В dev-логе есть ошибки ($ERRORS_COUNT)" "Последние 10 строк с ошибками:"
    grep -E "Error|ERROR|Failed|FAIL" "$DEV_LOG_FILE" | grep -v "terminated by signal" | grep -v "Bail out to client-side" | tail -10 | sed 's/^/       /' | tee -a "$LOG_FILE"
  fi

  # Показываем последние 5 строк dev-лога
  info "Последние 5 строк dev-лога:"
  tail -5 "$DEV_LOG_FILE" | sed 's/^/       /' | tee -a "$LOG_FILE"
fi

# ============================================================================
# Финальный отчёт
# ============================================================================
section "Финальный отчёт"

# Системная информация для контекста
log "${BOLD}Системная информация:${NC}"
log "  Платформа: $(uname -s) $(uname -r) $(uname -m)"
log "  Время: $(date)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  MAC_MODEL=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Model Name" | awk -F': ' '{print $2}')
  MAC_CPU=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Chip" | awk -F': ' '{print $2}')
  MAC_MEM=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Memory" | awk -F': ' '{print $2}')
  if [[ -n "$MAC_MODEL" ]]; then
    log "  Mac: $MAC_MODEL ($MAC_CPU, $MAC_MEM RAM)"
  fi
fi
log ""

log "${BOLD}Результаты:${NC}"
log "  ${GREEN}Прошло:    $PASS_COUNT${NC}"
log "  ${RED}Провалено:  $FAIL_COUNT${NC}"
log "  ${YELLOW}Предупреждений: $WARN_COUNT${NC}"
log "  ${DIM}Пропущено:  $SKIP_COUNT${NC}"
log ""

if [[ $FAIL_COUNT -gt 0 ]]; then
  log "${RED}${BOLD}❌ Есть критические проблемы${NC}"
  log ""

  # Специфичные рекомендации для Mac
  log "${BOLD}Частые проблемы и решения:${NC}"
  log ""
  log "  ${BOLD}Если Ollama недоступен:${NC}"
  log "    1. Открой приложение Ollama.app (через Spotlight или из /Applications)"
  log "    2. Или запусти в терминале: ollama serve"
  log "    3. Проверь что иконка Ollama появилась в строке меню macOS"
  log "    4. После запуска Ollama — перезапусти этот скрипт"
  log ""
  log "  ${BOLD}Если OLLAMA_MODEL пустой в .env:${NC}"
  log "    1. Открой .env в редакторе"
  log "    2. Заполни: OLLAMA_MODEL=qwen2.5:3b  (для 8GB RAM)"
  log "    3. Или: OLLAMA_MODEL=qwen2.5:7b  (для 16+GB RAM)"
  log "    4. Скачай модель: ollama pull qwen2.5:3b"
  log ""
  log "  ${BOLD}Если RAM <16GB (MacBook Air/Pro M1/M2 с 8GB):${NC}"
  log "    1. Используй лёгкие модели: qwen2.5:3b, phi3:mini, gemma2:2b"
  log "    2. Избегай 7B+ моделей — будут OOM и таймауты"
  log "    3. В .env увеличь LIA_LLM_TIMEOUT_MS=300000 (5 минут)"
  log ""
  log "  ${BOLD}Если chat/agent таймаутит:${NC}"
  log "    1. Проверь скорость LLM: оllama run qwen2.5:3b 'hello'"
  log "    2. Если <5 tok/s — используй модель поменьше"
  log "    3. Увеличь LIA_LLM_TIMEOUT_MS в .env (по умолчанию 180000 = 3 мин)"
  log "    4. Включи LOG_LEVEL=debug для детальных логов"
  log ""
  log "${BOLD}Что прислать для дальнейшей диагностики:${NC}"
  log "  1. Этот лог файл: $LOG_FILE"
  log "  2. Dev-лог: $DEV_LOG_FILE (если существует)"
  log "  3. Вывод команды: ollama list"
  log "  4. Скриншот окна Ollama (если есть)"
  log ""
elif [[ $WARN_COUNT -gt 0 ]]; then
  log "${YELLOW}${BOLD}⚠ Есть предупреждения, но критических проблем нет${NC}"
  log ""
  log "${BOLD}Рекомендации:${NC}"
  log "  1. Просмотри WARNING сообщения выше"
  log "  2. Если Lia работает медленно — увеличь LIA_LLM_TIMEOUT_MS в .env"
  log "  3. Пришли лог файл если будут вопросы: $LOG_FILE"
  log ""
else
  log "${GREEN}${BOLD}✅ Все проверки прошли успешно!${NC}"
  log ""
  log "Lia v2 готова к работе. Открой http://localhost:3000"
  log ""
fi

log "${BOLD}Полный лог:${NC} $LOG_FILE"
if [[ -f "$DEV_LOG_FILE" ]]; then
  log "${BOLD}Dev-лог:${NC}     $DEV_LOG_FILE"
fi
log ""
log "${DIM}Скрипт диагностики: scripts/diagnose.sh${NC}"

# Выходим с кодом 1 если есть FAIL, иначе 0
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
else
  exit 0
fi
