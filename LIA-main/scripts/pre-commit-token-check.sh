#!/usr/bin/env bash
# ============================================================================
# Pre-commit hook — блокирует коммит если в staged changes найдены секреты.
# ============================================================================
#
# Установка (один раз после clone):
#   cp scripts/pre-commit-token-check.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Или через husky (если установлен):
#   npx husky add .husky/pre-commit "bash scripts/pre-commit-token-check.sh"
#
# Что детектит:
#   - GitHub PAT: ghp_, gho_, ghs_, ghu_, github_pat_
#   - OpenAI: sk-, sk-proj-
#   - Anthropic: sk-ant-
#   - AWS: AKIA, AGPA, AIDA, AROA, AIPA, ANPA, ANVA, ASIA
#   - Google: AIza (API key), ya29 (OAuth)
#   - Slack: xoxb-, xoxp-, xoxa-
#   - Stripe: sk_live_, rk_live_
#   - GitLab: glpat-
#   - LIA_ENCRYPTION_KEY= с base64-значением (32 байта = 44 char base64)
#   - Общий паттерн: password=, secret=, api_key=, token= с длинным значением
#
# Если найден секрет — коммит блокируется, показывается file:line.
# Чтобы закоммитить секрет намеренно (НЕ рекомендуется) — используй
# `git commit --no-verify`.

set -e

# Паттерны секретов (extended regex)
PATTERNS=(
  # GitHub tokens
  'ghp_[0-9A-Za-z]{36}'
  'gho_[0-9A-Za-z]{36}'
  'ghs_[0-9A-Za-z]{36}'
  'ghu_[0-9A-Za-z]{36}'
  'github_pat_[0-9A-Za-z_]{82}'
  # OpenAI
  'sk-proj-[0-9A-Za-z_-]{56}'
  'sk-[0-9A-Za-z]{48}'
  # Anthropic
  'sk-ant-[0-9A-Za-z_-]{93}'
  # AWS access keys (20 char uppercase)
  'AKIA[0-9A-Z]{16}'
  'AGPA[0-9A-Z]{16}'
  'AIDA[0-9A-Z]{16}'
  'AROA[0-9A-Z]{16}'
  'AIPA[0-9A-Z]{16}'
  'ANPA[0-9A-Z]{16}'
  'ANVA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  # Google
  'AIza[0-9A-Za-z_-]{35}'
  'ya29\.[0-9A-Za-z_-]+'
  # Slack
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  # Stripe
  'sk_live_[0-9A-Za-z]{24,}'
  'rk_live_[0-9A-Za-z]{24,}'
  # GitLab
  'glpat-[0-9A-Za-z_-]{20}'
  # LIA_ENCRYPTION_KEY with value
  'LIA_ENCRYPTION_KEY=[A-Za-z0-9+/]{40,}={0,2}'
)

# Whitelist: файлы и паттерны, которые НЕ считаются секретом
WHITELIST_PATTERNS=(
  '\.env\.example$'           # .env.example — ожидаемо содержит placeholder
  '^scripts/pre-commit-token-check\.sh$'  # сам этот скрипт (содержит паттерны)
  '^scripts/setup\.mjs$'      # setup script упоминает паттерны в help тексте
  '^docs/SECURITY\.md$'       # документация может упоминать паттерны
  '^\.github/workflows/'      # CI конфиг может содержать test tokens
  'test[-_]|[-_]test[-_]|[-_]spec[-_]|[-_]mock[-_]|[-_]fixture[-_]|\.test\.[a-z]+$|\.spec\.[a-z]+$'  # тестовые файлы (test-foo, foo-test, foo.test.ts)
)

# Получаем staged changes (только добавленные/изменённые строки)
if ! git diff --cached --name-only | grep -q .; then
  exit 0  # nothing staged
fi

# Проверяем каждый staged файл
errors=0
while IFS= read -r file; do
  # Skip если файл удалён
  if ! [ -f "$file" ]; then
    continue
  fi

  # Проверяем whitelist
  whitelisted=false
  for pattern in "${WHITELIST_PATTERNS[@]}"; do
    if echo "$file" | grep -qE "$pattern"; then
      whitelisted=true
      break
    fi
  done
  if $whitelisted; then
    continue
  fi

  # Получаем staged diff для файла (только добавленные строки)
  diff_output=$(git diff --cached --unified=0 -- "$file" 2>/dev/null | grep '^+' | grep -v '^+++' || true)

  if [ -z "$diff_output" ]; then
    continue
  fi

  # Проверяем каждый паттерн
  for pattern in "${PATTERNS[@]}"; do
    matches=$(echo "$diff_output" | grep -nE "$pattern" || true)
    if [ -n "$matches" ]; then
      echo "❌ SECRET DETECTED in $file:"
      echo "$matches" | head -5 | sed 's/^/   /'
      echo "   Pattern: $pattern"
      echo ""
      errors=$((errors + 1))
    fi
  done
done <<< "$(git diff --cached --name-only)"

if [ $errors -gt 0 ]; then
  echo "🚫 Commit blocked: $errors secret(s) detected in staged changes."
  echo ""
  echo "If this is a false positive or you intentionally commit a secret:"
  echo "  git commit --no-verify"
  echo ""
  echo "If you accidentally committed a real token:"
  echo "  1. Revoke it immediately at the provider (GitHub: https://github.com/settings/tokens)"
  echo "  2. Remove from git history: git reset HEAD~1 && git commit --no-verify"
  echo "  3. Force-push: git push --force-with-lease"
  exit 1
fi

exit 0
