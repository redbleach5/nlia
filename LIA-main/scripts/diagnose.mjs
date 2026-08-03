// ============================================================================
// diagnose.mjs — кросс-платформенная диагностика окружения Lia v2.
// ============================================================================
//
// Замена diagnose.sh для Windows (где bash-скрипты ломаются из-за CRLF).
// Проверяет ключевые компоненты: node, bun, ollama, python3, git, БД.
// Полная диагностика (chat/agent/VRM тесты) осталась в diagnose.sh для Unix.
//
// Запуск:
//   bun run diagnose
//   node scripts/diagnose.mjs
//   bun run diagnose:verbose   (VERBOSE=1 — больше деталей)

import { existsSync, statSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { getEffectiveOllamaSettings } from './lib/effective-ollama.mjs';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = resolve(__dirname, '..');
const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

const OK = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ${OK} ${name}${detail && VERBOSE ? ` — ${detail}` : ''}`);
    passCount++;
  } else {
    console.log(`  ${FAIL} ${name}${detail ? ` — ${detail}` : ''}`);
    failCount++;
  }
}

function warn(name, detail = '') {
  console.log(`  ${WARN} ${name}${detail ? ` — ${detail}` : ''}`);
  warnCount++;
}

function info(msg) {
  if (VERBOSE) console.log(`  ${INFO} ${msg}`);
}

function tryExec(cmd) {
  try {
    // shell: true нужен на ВСЕХ платформах когда cmd — строка с аргументами
    // (например "node --version"). Без shell spawnSync ищет исполняемый файл
    // с именем "node --version" целиком, которого не существует.
    return spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function versionOf(cmd) {
  const r = tryExec(`${cmd} --version`);
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n')[0];
}

// ============================================================================
console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║  Lia v2 — Diagnostics                                       ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// ── 1. Окружение ──
console.log('Environment:');
const nodeVer = versionOf('node');
check('Node.js', !!nodeVer, nodeVer || 'not found');

const bunVer = versionOf('bun');
check('Bun (package manager)', !!bunVer, bunVer || 'not found (npm/yarn also work)');

const gitVer = versionOf('git');
check('Git', !!gitVer, gitVer || 'not found');

const pyVer = versionOf('python3') || versionOf('python');
check('Python 3', !!pyVer, pyVer || 'not found (needed for code_run tool)');

const curlVer = versionOf('curl');
check('curl', !!curlVer, curlVer || 'not found');

console.log('\nPlatform:', process.platform, process.arch);
console.log('Project dir:', PROJECT_DIR);

// ── 2. Ollama ──
console.log('\nOllama:');
const ollamaVer = versionOf('ollama');
check('Ollama installed', !!ollamaVer, ollamaVer || 'not found');

if (ollamaVer) {
  // Check if ollama serve is running
  try {
    const effective = getEffectiveOllamaSettings(PROJECT_DIR);
    const ollamaUrl = effective.baseUrl;
    const res = execSync(`curl -s ${ollamaUrl}/api/tags`, { encoding: 'utf8', timeout: 5000, shell: true });
    const data = JSON.parse(res);
    const models = (data.models ?? []).map(m => m.name);
    check('Ollama server running', true, `${models.length} models available`);
    if (models.length > 0) {
      info(`Models: ${models.slice(0, 5).join(', ')}${models.length > 5 ? ' ...' : ''}`);
      // Check for chat model
      const chatModel = effective.model;
      if (VERBOSE) info(`Effective chat model (${effective.source}): ${chatModel}`);
      const hasChat = models.some(m => m === chatModel || m.startsWith(chatModel.split(':')[0]));
      check(`Chat model (${chatModel})`, hasChat, hasChat ? 'available' : `not found — run: ollama pull ${chatModel}`);
      // Check for embed model
      const embedCandidates = models.filter(m =>
        m.startsWith('nomic-embed') || m.startsWith('mxbai-embed') ||
        m.startsWith('bge-') || m.startsWith('snowflake-arctic-embed')
      );
      check('Embedding model', embedCandidates.length > 0, embedCandidates[0] || 'not found — run: ollama pull nomic-embed-text');
    } else {
      warn('No models installed', 'run: ollama pull qwen3:8b && ollama pull nomic-embed-text');
    }
  } catch (e) {
    check('Ollama server running', false, `cannot connect to ${ollamaUrl} — run: ollama serve`);
  }
} else {
  warn('Ollama not installed', 'download from https://ollama.com — required for local LLM');
}

// ── 3. БД ──
console.log('\nDatabase:');
const dbDir = join(PROJECT_DIR, 'db');
const dbFile = join(dbDir, 'custom.db');
check('db/ directory exists', existsSync(dbDir), existsSync(dbDir) ? dbDir : 'run: bun run db:push');

if (existsSync(dbFile)) {
  const stat = statSync(dbFile);
  check('custom.db exists', true, `${(stat.size / 1024).toFixed(1)} KB`);
  // Check for WAL + SHM (SQLite WAL mode)
  const walExists = existsSync(join(dbDir, 'custom.db-wal'));
  const shmExists = existsSync(join(dbDir, 'custom.db-shm'));
  info(`WAL mode: ${walExists ? 'active' : 'not active (will activate on first write)'}`);
} else {
  check('custom.db exists', false, 'run: bun run db:push');
}

// ── 4. Зависимости проекта ──
console.log('\nDependencies:');
const nodeModulesExists = existsSync(join(PROJECT_DIR, 'node_modules'));
check('node_modules installed', nodeModulesExists, nodeModulesExists ? 'present' : 'run: bun install');

const prismaClientExists = existsSync(join(PROJECT_DIR, 'node_modules', '@prisma', 'client'));
check('Prisma client generated', prismaClientExists, prismaClientExists ? 'present' : 'run: bunx prisma generate');

// ── 5. VRM модели ──
console.log('\nAvatar:');
const modelsDir = join(PROJECT_DIR, 'public', 'models');
if (existsSync(modelsDir)) {
  const vrmFiles = readdirSync(modelsDir).filter(f => f.toLowerCase().endsWith('.vrm'));
  if (vrmFiles.length > 0) {
    check('VRM model present', true, vrmFiles.join(', '));
  } else {
    warn('No VRM models', 'upload a .vrm in Settings → Appearance or download the sample');
  }
} else {
  warn('public/models/ not found', 'create public/models/ and add a .vrm file');
}

// ── 6. .env ──
console.log('\nConfiguration:');
const envExists = existsSync(join(PROJECT_DIR, '.env'));
const envExampleExists = existsSync(join(PROJECT_DIR, '.env.example'));
if (envExists) {
  check('.env file exists', true);
} else if (envExampleExists) {
  warn('.env not found', 'copy .env.example to .env and fill in values');
} else {
  check('.env file exists', false, 'no .env.example template found either');
}

// ============================================================================
console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log(`║  Results: ${passCount} passed, ${failCount} failed, ${warnCount} warnings`);
console.log('╚═══════════════════════════════════════════════════════════╝');

if (failCount > 0) {
  console.log('\n❌ Some checks failed. Fix them before running `bun run dev`.\n');
  process.exit(1);
} else if (warnCount > 0) {
  console.log('\n⚠  Some warnings — app may work but with reduced functionality.\n');
  process.exit(0);
} else {
  console.log('\n✅ All checks passed. Run `bun run dev` to start.\n');
  process.exit(0);
}
