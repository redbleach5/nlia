// ============================================================================
// install-git-hooks.mjs — кросс-платформенная установка git hooks.
// ============================================================================
//
// Запускается автоматически через `postinstall` в package.json, или вручную:
//   node scripts/install-git-hooks.mjs
//   bun run setup:hooks
//
// Что делает:
//   - Копирует scripts/pre-commit-token-check.sh → .git/hooks/pre-commit
//   - chmod +x (на Unix)
//   - Логирует результат
//
// Идемпотентно — повторный запуск перезаписывает hook.
// Не падает если .git нет (например, при установке как dependency другого пакета).

import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const HOOK_SOURCE = resolve(__dirname, 'pre-commit-token-check.sh');
const GIT_DIR = resolve(PROJECT_ROOT, '.git');
const HOOKS_DIR = resolve(GIT_DIR, 'hooks');
const HOOK_TARGET = resolve(HOOKS_DIR, 'pre-commit');

// Проверяем что мы в git репозитории
if (!existsSync(GIT_DIR)) {
  // Не ошибка — может быть установлен как dependency
  console.log('[git-hooks] Not a git repository — skipping hook install');
  process.exit(0);
}

// Проверяем что source hook существует
if (!existsSync(HOOK_SOURCE)) {
  console.log('[git-hooks] pre-commit-token-check.sh not found in scripts/ — skipping');
  process.exit(0);
}

try {
  // Создаём .git/hooks/ если нет
  if (!existsSync(HOOKS_DIR)) {
    mkdirSync(HOOKS_DIR, { recursive: true });
  }

  // Копируем
  copyFileSync(HOOK_SOURCE, HOOK_TARGET);

  // chmod +x на Unix (на Windows это no-op, но не ошибка)
  if (process.platform !== 'win32') {
    chmodSync(HOOK_TARGET, 0o755);
  }

  console.log('[git-hooks] ✓ Pre-commit hook installed (.git/hooks/pre-commit)');
  console.log('[git-hooks]   Blocks commits containing GitHub/OpenAI/AWS/Slack/Stripe tokens');
  console.log('[git-hooks]   To bypass: git commit --no-verify');
} catch (e) {
  // Не падаем — postinstall не должен ломать install
  console.warn(`[git-hooks] ⚠️  Failed to install hook: ${e.message}`);
  console.warn('[git-hooks]   You can install manually: bun run setup:hooks');
  process.exit(0);
}
