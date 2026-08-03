import { describe, expect, it } from 'vitest';
import {
  parseProjectDesign,
  parseProjectDesignJson,
  serializeProjectDesign,
  previewUrlForDesign,
  previewDocumentPath,
  previewEntryRelativePath,
  htmlEntryFromPreviewUrl,
  PROJECT_MANIFEST_FILENAME,
} from '@/lib/agent/runtime/project-manifest';
import { inferProjectDesign, designNeedsRuntimeVerify } from '@/lib/agent/runtime/infer-design';
import { parseRuntimeScript } from '@/lib/agent/runtime/script-parse';
import { stepsHaveRuntimeVerify } from '@/lib/agent/runtime/verify';
import {
  shouldAcceptAgentCompletion,
  goalRequiresRuntimeVerify,
  fallbackPlan,
} from '@/lib/agent/runner-helpers';
import {
  createRuntimeCoachObservation,
  isIncompleteCreatePlan,
  isInspectOnlyAction,
  looksLikeServerStartCommand,
  trailingInspectOnlyCount,
} from '@/lib/agent/create-progress';
import {
  normalizeRuntimeScript,
  shouldFallbackToStaticServe,
  staticServeScript,
} from '@/lib/agent/runtime/script-normalize';
import {
  designFromPreset,
  isLockedPreset,
  resolveCreatePresetId,
  buildStaticWebDesign,
  buildViteReactDesign,
  buildNodeApiDesign,
} from '@/lib/agent/runtime/presets';
import { probeHttpUrl, isDirectoryListingHtml } from '@/lib/agent/runtime/health';

describe('Create Runtime — design + manifest', () => {
  it('infers HTML canvas game design with iframe preview', () => {
    const d = inferProjectDesign('Напиши игру змейка в браузере');
    expect(d.kind).toBe('game');
    expect(d.preset).toBe('static-game');
    expect(d.stack).toEqual(expect.arrayContaining(['html', 'canvas']));
    expect(d.preview.type).toBe('iframe');
    expect(d.preview.port).toBe(5173);
    expect(d.tree.map(t => t.path)).toEqual([
      'index.html',
      'style.css',
      'script.js',
      'lia.project.json',
    ]);
    expect(d.scripts.dev).toMatch(/npx --yes serve -l 5173/);
    expect(designNeedsRuntimeVerify(d)).toBe(true);
    expect(PROJECT_MANIFEST_FILENAME).toBe('lia.project.json');
  });

  it('validates and serializes lia.project.json', () => {
    const d = inferProjectDesign('Создай простой сайт-лендинг');
    const parsed = parseProjectDesign(d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const json = serializeProjectDesign(parsed.design);
    const again = parseProjectDesignJson(json);
    expect(again.ok).toBe(true);
    expect(previewUrlForDesign(parsed.design)).toBe('http://127.0.0.1:5173/index.html');
  });

  it('coerces iframe design without port to default 5173', () => {
    const fixed = parseProjectDesign({
      name: 'x',
      kind: 'web',
      stack: ['html'],
      tree: [{ path: 'index.html', role: 'entry' }],
      scripts: { start: 'npx serve' },
      preview: { type: 'iframe' },
      acceptance: 'ok',
      createdBy: 'lia',
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.design.preview.port).toBe(5173);
  });

  it('coerces weak-model propose_design payloads onto locked static preset', () => {
    const fixed = parseProjectDesign({
      name: 'medieval-tic-tac-toe',
      kind: 'web-game',
      stack: ['nodejs', 'express'],
      tree: [{ path: 'index.html', type: 'file' }],
      scripts: { start: 'node server.js' },
      preview: { type: 'iframe', port: 3000 },
      acceptance: 'playable',
      createdBy: 'lia',
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.design.kind).toBe('game');
    expect(fixed.design.preset).toBe('static-game');
    expect(fixed.design.preview.port).toBe(5173);
    expect(fixed.design.scripts.dev).toBe('npx --yes serve -l 5173');
    expect(fixed.design.tree[0].path).toBe('index.html');
  });

  it('does not collapse explicit vite stack to static serve', () => {
    const fixed = parseProjectDesign({
      name: 'fantasy-tictactoe',
      kind: 'game',
      stack: ['node', 'vite'],
      tree: [
        { path: 'src/index.html', role: 'file' },
        { path: 'src/main.js', role: 'file' },
      ],
      scripts: { dev: 'vite', start: 'vite' },
      preview: { type: 'iframe', port: 5173 },
      acceptance: 'playable',
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.design.preset).toBe('vite-react');
    expect(fixed.design.scripts.dev).toMatch(/npx --yes vite/);
    expect(fixed.design.tree.some(t => t.path === 'package.json')).toBe(true);
  });

  it('accepts tree as string paths and rewrites bare html game to root static preset', () => {
    const fixed = parseProjectDesign({
      name: 'x',
      kind: 'game',
      stack: ['html'],
      tree: ['src/index.html', 'src/main.js'],
      preview: { type: 'iframe' },
      acceptance: 'ok',
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.design.preset).toBe('static-game');
    expect(fixed.design.tree[0]).toEqual({ path: 'index.html', role: 'страница / точка входа' });
    expect(fixed.design.scripts.dev).toMatch(/serve/);
  });

  it('rejects designs with empty name even after coerce', () => {
    const bad = parseProjectDesign({
      name: '',
      kind: 'web',
      stack: ['html'],
      tree: [{ path: 'index.html', role: 'entry' }],
      scripts: { start: 'npx serve' },
      preview: { type: 'iframe', port: 5173 },
      acceptance: 'ok',
      createdBy: 'lia',
    });
    expect(bad.ok).toBe(false);
  });
});

describe('Create Runtime — script parse + verify', () => {
  it('parses allowlisted runtime scripts', () => {
    const p = parseRuntimeScript('npx --yes serve -l 5173');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.command).toBe('npx');
    expect(p.args).toEqual(['--yes', 'serve', '-l', '5173']);
  });

  it('rejects shell metacharacters and unknown binaries', () => {
    expect(parseRuntimeScript('npx serve | cat').ok).toBe(false);
    expect(parseRuntimeScript('curl http://x').ok).toBe(false);
  });

  it('detects successful runtime_start in steps', () => {
    expect(stepsHaveRuntimeVerify([
      { action: 'runtime_start', observation: '{"success":true,"status":"healthy","port":5173}' },
    ])).toBe(true);
    expect(stepsHaveRuntimeVerify([
      { action: 'runtime_start', observation: '{"success":false,"error":"port dead"}' },
    ])).toBe(false);
  });
});

describe('Create Runtime — completion gate', () => {
  it('requires runtime verify for create goals when flag set', () => {
    expect(goalRequiresRuntimeVerify('Напиши игру тетрис html')).toBe(true);

    expect(shouldAcceptAgentCompletion({
      goal: 'Напиши игру тетрис html',
      text: 'ГОТОВО: готово',
      stepsIncludingCurrent: [
        { action: 'write_file', observation: '{"path":"index.html"}' },
      ],
      requireRuntimeVerify: true,
    })).toBe(false);

    expect(shouldAcceptAgentCompletion({
      goal: 'Напиши игру тетрис html',
      text: 'ГОТОВО: готово',
      stepsIncludingCurrent: [
        { action: 'write_file', observation: '{"path":"index.html"}' },
        { action: 'runtime_start', observation: '{"success":true,"status":"healthy"}' },
      ],
      requireRuntimeVerify: true,
    })).toBe(true);
  });

  it('fallback create plan includes write + runtime_start for static preset', () => {
    const plan = fallbackPlan({
      id: 't',
      episodeId: 'e',
      goal: 'Создай игру змейка',
      status: 'pending',
      planJson: null,
      currentStep: 0,
      stepsJson: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      completedAt: null,
      error: null,
      maxSteps: 12,
      maxDurationSec: 600,
      toolsWhitelist: null,
      fsScope: '/tmp/agent-workspaces/x',
      checkpointJson: null,
      resultSummary: null,
      artifactsJson: '[]',
    });
    expect(plan.steps.some(s => /write_file|index\.html/.test(s))).toBe(true);
    expect(plan.steps.some(s => /runtime_start/.test(s))).toBe(true);
  });
});

describe('Create Runtime — script normalize', () => {
  it('rewrites bare vite to allowlisted npx vite', () => {
    expect(normalizeRuntimeScript('vite', 5173)).toBe(
      'npx --yes vite --host 127.0.0.1 --port 5173',
    );
  });

  it('builds static serve script for src root', () => {
    expect(staticServeScript(5173, 'src')).toBe('npx --yes serve -l 5173 src');
  });

  it('detects vite/port failures as serve-fallback candidates', () => {
    expect(shouldFallbackToStaticServe('command "vite" not allowed')).toBe(true);
    expect(shouldFallbackToStaticServe('Порт 5173 не отвечает за 25000ms')).toBe(true);
  });
});

describe('Create Runtime — presets', () => {
  it('locks games and simple sites to static presets', () => {
    expect(resolveCreatePresetId('Напиши средневековые крестики-нолики')).toBe('static-game');
    expect(isLockedPreset('static-game')).toBe(true);
    expect(resolveCreatePresetId('Сделай лендинг для кофейни')).toBe('static-web');
    expect(resolveCreatePresetId('Собери React dashboard на Vite')).toBe('vite-react');
  });

  it('explicit SPA stack wins over «игра» (no silent trap)', () => {
    expect(resolveCreatePresetId('Сделай игру на React')).toBe('vite-react');
    expect(resolveCreatePresetId('browser game with Vite and TypeScript')).toBe('vite-react');
    expect(resolveCreatePresetId('Next.js игра-платформер')).toBe('vite-react');
    expect(isLockedPreset(resolveCreatePresetId('Сделай игру на React'))).toBe(false);
  });

  it('API intent wins over game wording', () => {
    expect(resolveCreatePresetId('REST API для таблицы лидеров игры')).toBe('node-api');
    expect(resolveCreatePresetId('Express endpoint для scores')).toBe('node-api');
  });

  it('Python API gets dedicated python-api preset', () => {
    expect(resolveCreatePresetId('FastAPI сервис для scores')).toBe('python-api');
    expect(resolveCreatePresetId('Flask REST API')).toBe('python-api');
    expect(resolveCreatePresetId('python API для вебхуков')).toBe('python-api');
    expect(resolveCreatePresetId('Django admin API')).toBe('python-api');

    const fa = designFromPreset('FastAPI hello world');
    expect(fa.preset).toBe('python-api');
    expect(fa.entry).toBe('app.py');
    expect(fa.tree.some(t => t.path === 'requirements.txt')).toBe(true);
    expect(fa.scripts.install).toMatch(/pip install/);
    expect(fa.scripts.dev).toMatch(/python -m uvicorn/);
    expect(fa.preview.port).toBe(5173);

    const fl = designFromPreset('Flask hello');
    expect(fl.scripts.dev).toMatch(/python -m flask/);
  });

  it('Python scripts / pygame stay cli-script (not HTML, not node-api)', () => {
    expect(resolveCreatePresetId('игра на pygame')).toBe('cli-script');
    expect(resolveCreatePresetId('python скрипт парсинга CSV')).toBe('cli-script');
    const d = designFromPreset('игра на pygame');
    expect(d.preset).toBe('cli-script');
    expect(d.entry).toBe('main.py');
    expect(d.scripts.start).toBe('python main.py');
  });

  it('simple game without SPA stays locked static', () => {
    expect(resolveCreatePresetId('Игра тетрис fantasy')).toBe('static-game');
    expect(isLockedPreset('static-game')).toBe(true);
  });

  it('designFromPreset ignores free-form vite for simple games', () => {
    const d = designFromPreset('Игра тетрис fantasy');
    expect(d.preset).toBe('static-game');
    expect(d.scripts.dev).toBe('npx --yes serve -l 5173');
    expect(d.tree.every(t => !t.path.startsWith('src/'))).toBe(true);
  });

  it('designFromPreset keeps vite tree for React game goals', () => {
    const d = designFromPreset('Сделай игру на React');
    expect(d.preset).toBe('vite-react');
    expect(d.tree.some(t => t.path === 'package.json')).toBe(true);
    expect(d.scripts.dev).toMatch(/vite/);
  });
});

describe('Create Runtime — HTTP health', () => {
  it('accepts 200 and rejects 404', async () => {
    const ok = await probeHttpUrl('http://127.0.0.1:9/', {
      timeoutMs: 50,
      pollMs: 10,
      fetchImpl: (async () => new Response('<html><body>hi</body></html>', { status: 200 })) as typeof fetch,
    });
    expect(ok.ok).toBe(true);

    const bad = await probeHttpUrl('http://127.0.0.1:9/', {
      timeoutMs: 80,
      pollMs: 20,
      fetchImpl: (async () => new Response('missing', { status: 404 })) as typeof fetch,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/404/);
  });

  it('rejects directory listing bodies even with HTTP 200', async () => {
    expect(isDirectoryListingHtml('<html><title>Index of /task-123</title><a href="a">a</a></html>')).toBe(true);
    expect(isDirectoryListingHtml('<html><body><h1>Hello</h1></body></html>')).toBe(false);
    expect(isDirectoryListingHtml('{"ok":true}')).toBe(false);

    const listing = await probeHttpUrl('http://127.0.0.1:9/', {
      timeoutMs: 80,
      pollMs: 20,
      fetchImpl: (async () =>
        new Response('<html><title>Index of /task-abc</title><ul><li><a href="x">x</a></li></ul></html>', {
          status: 200,
        })) as typeof fetch,
    });
    expect(listing.ok).toBe(false);
    expect(listing.error).toMatch(/directory listing|точки входа/i);

    const jsonOk = await probeHttpUrl('http://127.0.0.1:9/health', {
      timeoutMs: 50,
      pollMs: 10,
      fetchImpl: (async () => new Response('{"status":"ok"}', { status: 200 })) as typeof fetch,
    });
    expect(jsonOk.ok).toBe(true);
  });
});

describe('Create Runtime — preview URL + entry contract', () => {
  it('static-web uses entry path in preview URL', () => {
    const d = buildStaticWebDesign('site');
    expect(previewDocumentPath(d)).toBe('/index.html');
    expect(previewUrlForDesign(d)).toBe('http://127.0.0.1:5173/index.html');
    expect(previewEntryRelativePath(d)).toBe('index.html');
    expect(htmlEntryFromPreviewUrl(previewUrlForDesign(d))).toBe('index.html');
  });

  it('vite-react keeps origin / (entry is source, not document)', () => {
    const d = buildViteReactDesign('app');
    expect(d.entry).toBe('src/App.tsx');
    expect(previewDocumentPath(d)).toBe('/');
    expect(previewUrlForDesign(d)).toBe('http://127.0.0.1:5173/');
    expect(previewEntryRelativePath(d)).toBeNull();
    expect(htmlEntryFromPreviewUrl(previewUrlForDesign(d))).toBeNull();
  });

  it('node-api has no iframe preview URL', () => {
    const d = buildNodeApiDesign('api');
    expect(d.preview.type).toBe('terminal');
    expect(previewUrlForDesign(d)).toBeNull();
    expect(previewEntryRelativePath(d)).toBeNull();
  });

  it('custom html entry maps to preview path', () => {
    const d = {
      ...buildStaticWebDesign('x'),
      entry: 'hello.html',
    };
    expect(previewUrlForDesign(d)).toBe('http://127.0.0.1:5173/hello.html');
    expect(previewEntryRelativePath(d)).toBe('hello.html');
  });

  it('explicit preview.url with path is preserved', () => {
    const d = {
      ...buildStaticWebDesign('x'),
      preview: { type: 'iframe' as const, port: 5173, url: 'http://127.0.0.1:5173/custom.html' },
    };
    expect(previewUrlForDesign(d)).toBe('http://127.0.0.1:5173/custom.html');
  });
});

describe('Create Runtime — HTML preview preflight', () => {
  it('fails when html entry file is missing; skips for SPA origin URL', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { assertHtmlPreviewEntryExists } = await import('@/lib/agent/runtime/process-supervisor');

    const cwd = await mkdtemp(join(tmpdir(), 'lia-preview-'));
    try {
      const missing = await assertHtmlPreviewEntryExists(cwd, 'http://127.0.0.1:5173/index.html');
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toMatch(/index\.html/);

      const spa = await assertHtmlPreviewEntryExists(cwd, 'http://127.0.0.1:5173/');
      expect(spa.ok).toBe(true);

      await writeFile(join(cwd, 'index.html'), '<html></html>', 'utf8');
      const ok = await assertHtmlPreviewEntryExists(cwd, 'http://127.0.0.1:5173/index.html');
      expect(ok.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('Create Runtime — progress coach', () => {
  it('flags incomplete create plans', () => {
    expect(isIncompleteCreatePlan(['propose_design'])).toBe(true);
    expect(isIncompleteCreatePlan([
      'propose_design',
      'write_file index.html',
      'runtime_start',
    ])).toBe(false);
  });

  it('detects inspect-only stalls', () => {
    expect(isInspectOnlyAction('read_file + read_file + list_tree')).toBe(true);
    expect(isInspectOnlyAction('write_file + read_file')).toBe(false);
    expect(trailingInspectOnlyCount([
      { action: 'write_file' },
      { action: 'read_file + read_file' },
      { action: 'read_file' },
      { action: 'list_tree' },
    ])).toBe(3);
  });

  it('detects server start via run_command', () => {
    expect(looksLikeServerStartCommand({
      command: 'node',
      args: ['server.js'],
    })).toBe(true);
    expect(looksLikeServerStartCommand({
      command: 'bun',
      args: ['test'],
    })).toBe(false);
  });

  it('coaches after inspect stall when writes exist but no runtime', () => {
    const hint = createRuntimeCoachObservation({
      goal: 'Напиши игру',
      steps: [
        { action: 'write_file', observation: '{"path":"index.html","written":true}' },
        { action: 'read_file', observation: 'html...' },
        { action: 'read_file', observation: 'css...' },
        { action: 'read_file', observation: 'js...' },
      ],
      maxSteps: 15,
      nextStepIndex: 8,
      requireRuntimeVerify: true,
      coachHintCount: 0,
    });
    expect(hint).toMatch(/runtime_start/);
  });

  it('coaches serve heal after failed runtime_start', () => {
    const hint = createRuntimeCoachObservation({
      goal: 'Напиши игру',
      steps: [
        { action: 'write_file', observation: '{"path":"src/index.html","written":true}' },
        {
          action: 'runtime_start',
          observation: '{"success":false,"error":"command \\"vite\\" not allowed"}',
        },
      ],
      maxSteps: 20,
      nextStepIndex: 5,
      requireRuntimeVerify: true,
      coachHintCount: 0,
    });
    expect(hint).toMatch(/index\.html|КОРЕНЬ|runtime_start/);
  });

  it('does not double-coach after a strategy_hint', () => {
    const hint = createRuntimeCoachObservation({
      goal: 'Напиши игру',
      steps: [
        { action: 'write_file', observation: '{"path":"index.html","written":true}' },
        { action: 'strategy_hint', observation: 'call runtime_start' },
      ],
      maxSteps: 15,
      nextStepIndex: 10,
      requireRuntimeVerify: true,
      coachHintCount: 0,
    });
    expect(hint).toBeNull();
  });
});
