import 'server-only';

// code_run — безопасное выполнение Python/JavaScript кода в sandbox.
//
// Подход (Phase 1 — усиление sandbox):
//   1. AST-анализ Python-кода через отдельный `python3 -c ast.parse` вызов:
//      - Запрещены Import/ImportFrom модулей из BLOCKED_PYTHON_MODULES
//      - Запрещены Call к eval/exec/compile/__import__/globals/locals
//      - Запрещён доступ к __builtins__, __import__, os.system, os.popen, subprocess.* и т.п.
//      Это надёжнее substring-блоклиста: не срабатывает на комментарии/строки/имена переменных.
//   2. Python: преамбула-обёртка ставит resource.setrlimit (CPU, heap, file size, no fork).
//   3. env очищен: нет PATH-утечки, нет HTTP_PROXY-tricks (raw socket их игнорирует),
//      но зато нет и обратного — переменные окружения хоста не утекают в sandbox.
//   4. Timeout 30s, max output 10KB, max code 50KB.
//
// Что НЕ покрывается (принимаемо для local-first single-user):
//   - Raw socket.create_connection в Python игнорирует proxy env vars.
//     Но: AST-анализ блокирует `import socket`, так что сети не будет.
//   - Filesystem read outside tempDir (например /etc/passwd).
//     Решение для production: firejail/bwrap/Docker с read-only rootfs.
//   - Side-channel атаки (CPU cache, fork bombs через multiprocessing — последний в blocklist).

import { execFile } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

// Windows часто ставит интерпретатор как `python`, а не `python3`.
// На Win32 тесты и рантайм должны использовать один и тот же бинарник.
const PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python' : 'python3';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10_000;
const MAX_CODE_SIZE = 50_000;
// Python: heap limit 256MB, file size 1MB, CPU 10s (timeout 30s даст margin).
const PY_RLIMIT_AS = 256 * 1024 * 1024;       // RLIMIT_AS — address space
const PY_RLIMIT_FSIZE = 1 * 1024 * 1024;      // RLIMIT_FSIZE — max file write
const PY_RLIMIT_CPU = 10;                     // RLIMIT_CPU — seconds
const PY_RLIMIT_NPROC = 0;                    // RLIMIT_NPROC — 0 = no child processes

// ============================================================================
// White-list approach (P0-2 fix, C-SEC-4).
// Previously used a black-list missing `sys`, `types`, `gc`, `weakref`,
// `platform`, `threading` — each allowing trivial sandbox escape.
// ============================================================================
const ALLOWED_PYTHON_MODULES = new Set([
  'math', 'cmath', 'statistics', 'fractions', 'decimal', 'numbers',
  'json', 're',
  'itertools', 'collections', 'functools', 'heapq', 'bisect',
  'datetime', 'time', 'calendar',
  'random', 'secrets',
  'string', 'textwrap', 'unicodedata', 'difflib',
  'base64', 'binascii', 'struct', 'hashlib', 'hmac',
  'copy', 'uuid',
  'csv',
  'operator',
]);

const BLOCKED_PYTHON_MODULES = new Set([
  // ── Sandbox escape vectors (CRITICAL — were missing before P0-2) ──
  'sys', 'types', 'gc', 'weakref', 'platform', 'threading', '_thread',
  'posixpath', 'ntpath', 'genericpath',
  // Subprocess / process control
  'subprocess', 'multiprocessing', 'ctypes', 'cffi',
  // Network
  'socket', 'socketserver', 'http.server', 'http.client',
  'urllib.request', 'urllib2', 'requests', 'httpx', 'aiohttp',
  'ftplib', 'smtplib', 'telnetlib', 'paramiko',
  'asyncio',
  // Serialization (pickle RCE)
  'pickle', 'marshal', 'shelve', 'copyreg',
  // Dynamic import / module manipulation
  'importlib', 'imp',
  // ── Файловая система и ОС ──
  'os', 'os.path', 'shutil', 'pathlib', 'io', 'tempfile', 'glob', 'fnmatch',
  'linecache', 'dbm', 'zipfile', 'tarfile', 'gzip', 'bz2', 'lzma',
  'fileinput', 'filecmp', 'stat', 'pty', 'select', 'selectors', 'signal',
  'resource',
  // Builtins manipulation
  'builtins', '__builtin__',
  // Misc dangerous
  'runpy', 'code', 'codeop', 'pdb', 'bdb', 'traceback', 'inspect',
]);

// Опасные call-targets — блокируем на уровне AST Call node.
const BLOCKED_PYTHON_CALLS = new Set([
  'eval', 'exec', 'compile',
  '__import__',
  'globals', 'locals',
  'getattr', 'setattr', 'delattr',  // обход static-анализа через getattr(os, 'system')
  'vars',
  // ── Builtin file access (CRITICAL) ──
  'open',         // builtin open() — чтение/запись любых файлов
  'input',        // не опасно, но мешает (stdin)
  'breakpoint',   // запускает pdb
  'exit', 'quit', // завершение процесса
  'help',         // запускает интерактивный help
]);

// Опасные attribute access — блокируем на уровне AST Attribute node.
const BLOCKED_PYTHON_ATTRS = new Set([
  // ── Bypass prevention — обход static анализа через reflection ──
  '__builtins__',
  '__subclasses__',  // классическая атака: ().class__.__bases__[0].__subclasses__()
  '__globals__',
  '__code__',         // функция.__code__ = malicious_code_object
  '__class__',        // обход через type() и mro
  '__mro__',          // method resolution order — поиск классов
  '__bases__',        // обход через базовые классы
  '__dict__',         // прямой доступ к dict объектов (может подменить builtins)
  // ── os.* методы (на случай если os импортирован через обход) ──
  'system', 'popen', 'exec', 'fork',
  'symlink', 'link', 'readlink',  // создание symbolic/hard links
  // ── shutil.* методы ──
  'rmtree', 'move', 'copy', 'copyfile', 'copytree',
  // ── pathlib.Path.* методы (pathlib заблокирован, но для надёжности) ──
  'read_text', 'read_bytes', 'write_text', 'write_bytes',
]);

// Python AST-анализатор. Запускается как отдельный `python3 -c` процесс.
// Возвращает JSON: { ok: true } | { ok: false, error: string }
export const PYTHON_AST_VALIDATOR = `
import ast, json, sys

ALLOWED_MODULES = ${JSON.stringify([...ALLOWED_PYTHON_MODULES])}
BLOCKED_MODULES = ${JSON.stringify([...BLOCKED_PYTHON_MODULES])}
BLOCKED_CALLS = ${JSON.stringify([...BLOCKED_PYTHON_CALLS])}
BLOCKED_ATTRS = ${JSON.stringify([...BLOCKED_PYTHON_ATTRS])}

def check(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError: {e.msg} (line {e.lineno})"}

    for node in ast.walk(tree):
        # White-list: reject ANY import not in ALLOWED_MODULES.
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split('.')[0]
                if top in BLOCKED_MODULES or alias.name in BLOCKED_MODULES:
                    return {"ok": False, "error": f"blocked import: {alias.name}"}
                if top not in ALLOWED_MODULES and alias.name not in ALLOWED_MODULES:
                    return {"ok": False, "error": f"module not in allow-list: {alias.name} (allowed: math, json, re, itertools, collections, functools, datetime, random, ...)"}
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or '').split('.')[0]
            mod = node.module or ''
            if top in BLOCKED_MODULES or mod in BLOCKED_MODULES:
                return {"ok": False, "error": f"blocked from-import: {mod}"}
            if top not in ALLOWED_MODULES and mod not in ALLOWED_MODULES:
                return {"ok": False, "error": f"module not in allow-list: {mod} (allowed: math, json, re, itertools, collections, functools, datetime, random, ...)"}
        elif isinstance(node, ast.Call):
            fn = node.func
            name = None
            if isinstance(fn, ast.Name):
                name = fn.id
            elif isinstance(fn, ast.Attribute):
                name = fn.attr
            if name in BLOCKED_CALLS:
                return {"ok": False, "error": f"blocked call: {name}"}
        elif isinstance(node, ast.Attribute):
            if node.attr in BLOCKED_ATTRS:
                return {"ok": False, "error": f"blocked attribute: {node.attr}"}

    return {"ok": True}

if __name__ == '__main__':
    code_path = sys.argv[1]
    with open(code_path, 'r', encoding='utf-8') as f:
        code = f.read()
    print(json.dumps(check(code)))
`;

// Префикс для Python-скрипта — ставит resource limits перед выполнением user code.
const PYTHON_RESOURCE_PREFIX = `
import resource
resource.setrlimit(resource.RLIMIT_AS, (${PY_RLIMIT_AS}, ${PY_RLIMIT_AS}))
resource.setrlimit(resource.RLIMIT_FSIZE, (${PY_RLIMIT_FSIZE}, ${PY_RLIMIT_FSIZE}))
resource.setrlimit(resource.RLIMIT_CPU, (${PY_RLIMIT_CPU}, ${PY_RLIMIT_CPU}))
try:
    resource.setrlimit(resource.RLIMIT_NPROC, (${PY_RLIMIT_NPROC}, ${PY_RLIMIT_NPROC}))
except (ValueError, OSError):
    pass  # RLIMIT_NPROC не везде поддерживается (macOS)
`;

/**
 * AST-анализ Python-кода. Записывает код во временный файл, запускает python3 -c ast_validator с путём к файлу как argv[1].
 * Возвращает { ok: true } или { ok: false, error: string }.
 */
async function validatePythonCodeAst(code: string): Promise<{ ok: boolean; error?: string }> {
  const astDir = join(tmpdir(), `lia-ast-${randomUUID()}`);
  await mkdir(astDir, { recursive: true });
  const codePath = join(astDir, 'user_code.py');
  try {
    await writeFile(codePath, code, 'utf8');
    // Windows CI cold-starts of `python -c <large validator>` often exceed 5s
    // on the first invocation; keep Linux/mac tight, give Win room.
    const astTimeoutMs = process.platform === 'win32' ? 30_000 : 5_000;
    const result = await execFileAsync(PYTHON_EXECUTABLE, ['-c', PYTHON_AST_VALIDATOR, codePath], {
      timeout: astTimeoutMs,
      maxBuffer: 10_000,
    });
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string };
    return parsed;
  } catch (e) {
    // python3 не установлен / упал — не позволяем выполнять unchecked код
    logger.warn('tools', `code_run: AST validation failed (${PYTHON_EXECUTABLE} missing?)`, {}, e);
    return { ok: false, error: 'Python AST validation unavailable — refusing to run' };
  } finally {
    try { await rm(astDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * JavaScript: валидация через vm sandbox (см. runCode).
 * Раньше использовался regex-блоклист, но он обходится через string concat,
 * char codes, globalThis.require, и т.п. Теперь код выполняется в vm context
 * БЕЗ require/process/global/Buffer — нет доступа к FS/network/process.
 * vm.runInContext имеет timeout — код не может висеть бесконечно.
 */
// validateJsCode удалён — sandbox заменяет static analysis.

export type CodeRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
};

export async function runCode(code: string, language: 'python' | 'javascript' = 'python'): Promise<CodeRunResult> {
  if (code.length > MAX_CODE_SIZE) {
    return {
      stdout: '',
      stderr: `Code too large: ${code.length} bytes (max ${MAX_CODE_SIZE})`,
      exitCode: 1,
      durationMs: 0,
      truncated: false,
    };
  }

  // AST validation для Python. JS валидируется через vm sandbox (нет require/process).
  if (language === 'python') {
    const ast = await validatePythonCodeAst(code);
    if (!ast.ok) {
      return {
        stdout: '',
        stderr: ast.error ?? 'code validation failed',
        exitCode: 1,
        durationMs: 0,
        truncated: false,
      };
    }
  }

  const sessionId = randomUUID();
  const tempDir = join(tmpdir(), `lia-code-${sessionId}`);
  await mkdir(tempDir, { recursive: true });

  const startTime = Date.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let truncated = false;

  try {
    // Минимальный env — никаких HTTP_PROXY-tricks (raw socket их игнорирует),
    // никаких утечек окружения хоста (DATABASE_URL, LIA_* и т.п.).
    const safeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: tempDir,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      // Python-specific
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONHASHSEED: 'random',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      // Node-specific
      NODE_OPTIONS: '',  // запретить --require, --experimental-* и т.п.
    };

    if (language === 'python') {
      const scriptPath = join(tempDir, 'script.py');
      // Префикс ставит resource limits, затем выполняет user code.
      const fullCode = `${PYTHON_RESOURCE_PREFIX}\n${code}`;
      await writeFile(scriptPath, fullCode, 'utf8');

      const result = await execFileAsync(PYTHON_EXECUTABLE, ['-I', scriptPath], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env: safeEnv,
        killSignal: 'SIGKILL',
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } else {
      // JavaScript — выполняем в sandbox через node:vm.
      // Создаём минимальный context БЕЗ require, process, global, __dirname.
      // Это надёжнее regex-блоклиста (который обходится через string concat,
      // char codes, globalThis.require, и т.п.).
      const scriptPath = join(tempDir, 'script.js');
      // Оборачиваем user code в vm.runInNewContext с sandboxed globals.
      // console.log перехватываем в stdout, console.error — в stderr.
      const wrapperCode = `
const vm = require('vm');
const { readFileSync } = require('fs');

const userCode = readFileSync(${JSON.stringify(scriptPath)}, 'utf8');

let _stdout = '';
let _stderr = '';

const sandbox = {
  console: {
    log: (...args) => { _stdout += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n'; },
    error: (...args) => { _stderr += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n'; },
    warn: (...args) => { _stderr += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n'; },
    info: (...args) => { _stdout += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n'; },
  },
  // Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp,
  // Map, Set, Promise, Error — стандартные встроенные объекты доступны
  // автоматически в vm context. НЕ передаём: require, process, global,
  // __dirname, __filename, Buffer, setTimeout/setInterval (могут висеть).
  setTimeout: undefined,
  setInterval: undefined,
  setImmediate: undefined,
  process: undefined,
  require: undefined,
  global: undefined,
  Buffer: undefined,
};

try {
  vm.createContext(sandbox);
  vm.runInContext(userCode, sandbox, {
    timeout: ${TIMEOUT_MS - 5000},  // 5 сек запас на startup
    displayErrors: true,
  });
} catch (e) {
  _stderr += (e && e.stack ? e.stack : String(e)) + '\\n';
  process.exitCode = 1;
}

// Выводим собранный stdout/stderr в реальный process.stdout/stderr
if (_stdout) process.stdout.write(_stdout);
if (_stderr) process.stderr.write(_stderr);
`;

      // Сначала пишем user code в script.js
      await writeFile(scriptPath, code, 'utf8');
      // Потом пишем wrapper в wrapper.js
      const wrapperPath = join(tempDir, 'wrapper.js');
      await writeFile(wrapperPath, wrapperCode, 'utf8');

      const result = await execFileAsync('node', [
        '--max-old-space-size=128',
        '--max-semi-space-size=16',
        '--no-warnings',
        // P1-1 fix (H-SEC-8): disallow code generation from strings inside the VM.
        // Prevents `new Function('return this')()` and similar escapes from
        // re-entering privileged scopes via eval-like APIs.
        '--disallow-code-generation-from-strings',
        wrapperPath,
      ], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env: safeEnv,
        killSignal: 'SIGKILL',
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number; signal?: string; killed?: boolean };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    exitCode = typeof err.code === 'number' ? err.code : 1;

    if (err.killed || err.signal === 'SIGKILL') {
      stderr += '\n(Process killed — timeout or memory/CPU limit exceeded)';
    }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  const durationMs = Date.now() - startTime;

  if (stdout.length > MAX_OUTPUT_BYTES) {
    stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }
  if (stderr.length > MAX_OUTPUT_BYTES) {
    stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }

  return { stdout, stderr, exitCode, durationMs, truncated };
}
