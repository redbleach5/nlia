// ============================================================================
// Create Runtime presets — canonical scaffolds (no free-form stack inventing).
// Pure / client-safe.
// ============================================================================

import type { ProjectDesign, ProjectKind } from './types';

export const DEFAULT_PREVIEW_PORT = 5173;

export const CREATE_PRESET_IDS = [
  'static-game',
  'static-web',
  'vite-react',
  'node-api',
  'python-api',
  'cli-script',
] as const;

export type CreatePresetId = (typeof CREATE_PRESET_IDS)[number];

export type CreatePreset = {
  id: CreatePresetId;
  /** When true, propose_design may only change name/acceptance — tree/scripts locked. */
  locked: boolean;
  label: string;
  kind: ProjectKind;
};

function slugifyName(goal: string): string {
  const raw = goal
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return raw || 'artifact';
}

function staticServeScripts(port = DEFAULT_PREVIEW_PORT) {
  const cmd = `npx --yes serve -l ${port}`;
  return { dev: cmd, start: cmd };
}

/** Fixed root layout — never src/. Compatible with `npx serve -l 5173 .` */
function staticTree(kind: 'game' | 'web'): ProjectDesign['tree'] {
  return [
    { path: 'index.html', role: kind === 'game' ? 'страница игры / точка входа' : 'страница / точка входа' },
    { path: 'style.css', role: 'стили' },
    { path: 'script.js', role: 'логика' },
    { path: 'lia.project.json', role: 'манифест Create Runtime' },
  ];
}

export function buildStaticGameDesign(name: string, opts?: { canvas?: boolean }): ProjectDesign {
  const port = DEFAULT_PREVIEW_PORT;
  return {
    name: name || 'game',
    kind: 'game',
    preset: 'static-game',
    stack: opts?.canvas
      ? ['html', 'css', 'javascript', 'canvas']
      : ['html', 'css', 'javascript'],
    tree: staticTree('game'),
    scripts: staticServeScripts(port),
    preview: { type: 'iframe', port },
    entry: 'index.html',
    acceptance:
      'Preview http://127.0.0.1:5173 открывается, index.html отдаёт 200, игровой сценарий работает.',
    createdBy: 'lia',
  };
}

export function buildStaticWebDesign(name: string): ProjectDesign {
  const port = DEFAULT_PREVIEW_PORT;
  return {
    name: name || 'site',
    kind: 'web',
    preset: 'static-web',
    stack: ['html', 'css', 'javascript'],
    tree: staticTree('web'),
    scripts: staticServeScripts(port),
    preview: { type: 'iframe', port },
    entry: 'index.html',
    acceptance:
      'Preview http://127.0.0.1:5173 открывается, index.html отдаёт 200, страница без ошибок.',
    createdBy: 'lia',
  };
}

export function buildViteReactDesign(name: string): ProjectDesign {
  const port = DEFAULT_PREVIEW_PORT;
  return {
    name: name || 'app',
    kind: 'web',
    preset: 'vite-react',
    stack: ['vite', 'react', 'typescript'],
    tree: [
      { path: 'package.json', role: 'зависимости и scripts' },
      { path: 'index.html', role: 'HTML shell' },
      { path: 'src/main.tsx', role: 'точка входа' },
      { path: 'src/App.tsx', role: 'UI' },
      { path: 'lia.project.json', role: 'манифест Create Runtime' },
    ],
    scripts: {
      install: 'npm install',
      dev: `npx --yes vite --host 127.0.0.1 --port ${port}`,
      start: `npx --yes vite --host 127.0.0.1 --port ${port}`,
    },
    preview: { type: 'iframe', port },
    entry: 'src/App.tsx',
    acceptance: 'Dev-сервер отвечает; GET / возвращает 200.',
    createdBy: 'lia',
  };
}

export function buildNodeApiDesign(name: string): ProjectDesign {
  const port = DEFAULT_PREVIEW_PORT;
  return {
    name: name || 'api',
    kind: 'api',
    preset: 'node-api',
    stack: ['node', 'http'],
    tree: [
      { path: 'server.js', role: 'HTTP API' },
      { path: 'package.json', role: 'скрипты запуска' },
      { path: 'lia.project.json', role: 'манифест Create Runtime' },
    ],
    scripts: {
      start: 'node server.js',
      dev: 'node server.js',
    },
    preview: { type: 'terminal', port },
    entry: 'server.js',
    acceptance: 'Сервер слушает порт; GET / или /health возвращает 200.',
    createdBy: 'lia',
  };
}

/**
 * Python HTTP API — FastAPI / Flask / Django.
 * Runtime via allowlisted `python` / `pip` only (no bare uvicorn binary).
 */
export function buildPythonApiDesign(name: string, goal: string): ProjectDesign {
  const g = goal.toLowerCase();
  const port = DEFAULT_PREVIEW_PORT;
  const isFlask = /\bflask\b/.test(g);
  const isDjango = /\bdjango\b/.test(g);

  if (isDjango) {
    const cmd = `python manage.py runserver 127.0.0.1:${port}`;
    return {
      name: name || 'api',
      kind: 'api',
      preset: 'python-api',
      stack: ['python', 'django'],
      tree: [
        { path: 'manage.py', role: 'Django entry' },
        { path: 'requirements.txt', role: 'зависимости' },
        { path: 'lia.project.json', role: 'манифест Create Runtime' },
      ],
      scripts: {
        install: 'pip install -r requirements.txt',
        dev: cmd,
        start: cmd,
      },
      preview: { type: 'terminal', port },
      entry: 'manage.py',
      acceptance: `Django отвечает на http://127.0.0.1:${port} (HTTP 200).`,
      createdBy: 'lia',
    };
  }

  if (isFlask) {
    const cmd = `python -m flask --app app run --host 127.0.0.1 --port ${port}`;
    return {
      name: name || 'api',
      kind: 'api',
      preset: 'python-api',
      stack: ['python', 'flask'],
      tree: [
        { path: 'app.py', role: 'Flask app' },
        { path: 'requirements.txt', role: 'зависимости (flask)' },
        { path: 'lia.project.json', role: 'манифест Create Runtime' },
      ],
      scripts: {
        install: 'pip install -r requirements.txt',
        dev: cmd,
        start: cmd,
      },
      preview: { type: 'terminal', port },
      entry: 'app.py',
      acceptance: `Flask отвечает на http://127.0.0.1:${port} (HTTP 200).`,
      createdBy: 'lia',
    };
  }

  // Default Python API → FastAPI + uvicorn module
  const cmd = `python -m uvicorn app:app --host 127.0.0.1 --port ${port}`;
  return {
    name: name || 'api',
    kind: 'api',
    preset: 'python-api',
    stack: ['python', 'fastapi'],
    tree: [
      { path: 'app.py', role: 'FastAPI app (ASGI `app`)' },
      { path: 'requirements.txt', role: 'зависимости (fastapi, uvicorn)' },
      { path: 'lia.project.json', role: 'манифест Create Runtime' },
    ],
    scripts: {
      install: 'pip install -r requirements.txt',
      dev: cmd,
      start: cmd,
    },
    preview: { type: 'terminal', port },
    entry: 'app.py',
    acceptance: `FastAPI отвечает на http://127.0.0.1:${port} (HTTP 200 на / или /docs).`,
    createdBy: 'lia',
  };
}

/** One-shot CLI / pygame / python or node script (not a long-lived HTTP API). */
export function buildCliScriptDesign(name: string, goal: string): ProjectDesign {
  const g = goal.toLowerCase();
  const wantsJs =
    /\b(javascript|node|\.js\b|typescript)\b/.test(g)
    && !/\b(python|pygame|\.py\b)\b/.test(g);
  const entry = wantsJs ? 'main.js' : 'main.py';
  const isJs = entry.endsWith('.js');
  const startCmd = isJs ? `node ${entry}` : `python ${entry}`;
  return {
    name: name || 'script',
    kind: /cli\b|утилит|командн/.test(g) ? 'cli' : 'script',
    preset: 'cli-script',
    stack: isJs ? ['node'] : ['python'],
    tree: [
      { path: entry, role: 'точка входа' },
      ...(isJs ? [] : [{ path: 'requirements.txt', role: 'зависимости (если нужны)' }]),
      { path: 'lia.project.json', role: 'манифест Create Runtime' },
    ],
    scripts: {
      ...(isJs ? {} : { install: 'pip install -r requirements.txt' }),
      start: startCmd,
      dev: startCmd,
    },
    preview: { type: 'terminal' },
    entry,
    acceptance: 'Скрипт завершается с кодом 0 (или показывает ожидаемый вывод в терминале).',
    createdBy: 'lia',
  };
}

/** Explicit SPA / app framework in the user goal — wins over «игра». */
const SPA_STACK_RE = /\b(react|vite|next\.?js|next\b|vue|svelte|nuxt|remix|astro)\b/;

/** Python web frameworks / python+API wording. */
function isPythonApiGoal(g: string): boolean {
  if (/\b(fastapi|flask|django)\b/.test(g)) return true;
  // «python API», «API на python», без ухода в node-api
  return /\bpython\b/.test(g) && /\b(api\b|endpoint|rest\b|graphql|сервер|uvicorn)\b/.test(g);
}

function isPythonScriptGoal(g: string): boolean {
  return /\b(python|pygame|\.py\b)\b/.test(g);
}

/** Node/generic API intent (Python frameworks excluded — handled above). */
const NODE_API_RE = /\b(api\b|endpoint|rest\b|graphql|express|nestjs|сервер\s+api|http\s+api)\b/;

/** CLI / script intent (narrow — bare «скрипт» alone is too broad). */
const CLI_RE = /\b(cli\b|утилит|командн|terminal\b|скрипт\s+для\s+терминал)\b/;

/** Simple browser game without an app framework. */
const GAME_RE = /игр[уыа]|\bgame\b|тетрис|tetris|змейк|snake|arkanoid|platformer|tic-?tac|крестики/;

/**
 * Resolve create preset with explicit priority (no silent traps):
 * 1) SPA → vite-react
 * 2) Python API → python-api
 * 3) Python/pygame script → cli-script
 * 4) Node/generic API → node-api
 * 5) CLI → cli-script
 * 6) Simple browser game → static-game
 * 7) Default → static-web
 */
export function resolveCreatePresetId(goal: string): CreatePresetId {
  const g = goal.toLowerCase();

  if (SPA_STACK_RE.test(g) || /create-react-app|create-vite/.test(g)) {
    return 'vite-react';
  }

  if (isPythonApiGoal(g)) {
    return 'python-api';
  }

  if (isPythonScriptGoal(g)) {
    return 'cli-script';
  }

  if (NODE_API_RE.test(g) && !/сайт|лендинг|страниц/.test(g)) {
    return 'node-api';
  }

  if (CLI_RE.test(g)) {
    return 'cli-script';
  }

  if (GAME_RE.test(g)) {
    return 'static-game';
  }

  return 'static-web';
}

export function isLockedPreset(id: CreatePresetId): boolean {
  return id === 'static-game' || id === 'static-web';
}

export function describePresetForPrompt(id: CreatePresetId): string {
  if (id === 'static-game' || id === 'static-web') {
    return (
      `Preset «${id}» (LOCKED): write_file ТОЛЬКО index.html, style.css, script.js в корне sandbox. `
      + 'Запрещено: src/, vite, express, package.json, порт 3000. '
      + 'После записи — runtime_start без script override (уже npx serve на 5173).'
    );
  }
  if (id === 'vite-react') {
    return 'Preset «vite-react»: write_file package.json + index.html + src/main.tsx + src/App.tsx → npm install при необходимости → runtime_start.';
  }
  if (id === 'node-api') {
    return 'Preset «node-api»: write_file server.js + package.json → runtime_start.';
  }
  if (id === 'python-api') {
    return (
      'Preset «python-api»: write_file app.py (или manage.py) + requirements.txt '
      + '→ pip install -r requirements.txt → runtime_start (uvicorn/flask/django на 5173).'
    );
  }
  return 'Preset «cli-script»: write_file main.py или main.js (+ requirements.txt при Python) → runtime_start.';
}

/**
 * Build the canonical design for a goal. Locked presets ignore free-form stacks.
 */
export function designFromPreset(
  goal: string,
  opts?: { name?: string; acceptance?: string },
): ProjectDesign {
  const id = resolveCreatePresetId(goal);
  const name = slugifyName(opts?.name?.trim() || goal);
  const g = goal.toLowerCase();

  let design: ProjectDesign;
  switch (id) {
    case 'static-game':
      design = buildStaticGameDesign(name, { canvas: /canvas|анимац|змейк|snake|tetris|тетрис/.test(g) });
      break;
    case 'static-web':
      design = buildStaticWebDesign(name);
      break;
    case 'vite-react':
      design = buildViteReactDesign(name);
      break;
    case 'node-api':
      design = buildNodeApiDesign(name);
      break;
    case 'python-api':
      design = buildPythonApiDesign(name, goal);
      break;
    default:
      design = buildCliScriptDesign(name, goal);
  }

  if (opts?.acceptance?.trim()) {
    design = { ...design, acceptance: opts.acceptance.trim().slice(0, 500) };
  }
  return design;
}

/** Overlay a model propose_design onto a locked preset (keep name/acceptance only). */
export function lockDesignToPreset(
  goal: string,
  raw: { name?: string; acceptance?: string },
): ProjectDesign {
  return designFromPreset(goal, {
    name: raw.name,
    acceptance: raw.acceptance,
  });
}
