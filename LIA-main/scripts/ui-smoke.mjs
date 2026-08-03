/**
 * Fast UI/API smoke without Playwright browser download.
 * Verifies SSR home + API surface + workspace kind alignment.
 */
const BASE = process.env.LIA_BASE_URL || 'http://localhost:3000';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
function ok(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, err) {
  results.push({ name, ok: false, detail: String(err) });
  console.error(`✗ ${name} — ${err}`);
}

async function waitReady(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Server not ready');
}

async function main() {
  const health = await waitReady();
  ok('health', `models=${(health.models || []).length}`);

  for (const path of [
    '/api/settings',
    '/api/kb/sources',
    '/api/agent',
    '/api/capability',
  ]) {
    try {
      const r = await fetch(`${BASE}${path}`);
      assert(r.ok, `status ${r.status}`);
      ok(`GET ${path}`, String(r.status));
    } catch (e) {
      fail(`GET ${path}`, e.message || e);
    }
  }

  // Cancel transient agents
  try {
    const list = await (await fetch(`${BASE}/api/agent`)).json();
    const tasks = Array.isArray(list) ? list : (list.tasks || []);
    let cancelled = 0;
    for (const t of tasks) {
      if (['planning', 'executing', 'waiting_input', 'synthesizing', 'pending'].includes(t.status)) {
        const r = await fetch(`${BASE}/api/agent/${t.id}/cancel`, { method: 'POST' });
        if (r.ok) cancelled++;
      }
    }
    ok('cancel transient agents', `cancelled=${cancelled}`);
  } catch (e) {
    fail('cancel transient agents', e.message || e);
  }

  // Home HTML
  try {
    const r = await fetch(BASE, { headers: { Accept: 'text/html' } });
    assert(r.ok, `home ${r.status}`);
    const html = await r.text();
    assert(html.length > 500, 'tiny html');
    assert(!/Parsing ecmascript|Unexpected token `contextLoadStart`/i.test(html), 'compile error in HTML');
    assert(!/Application error: a client-side exception/i.test(html), 'client exception banner');
    // Next.js app shell markers
    assert(html.includes('/_next/') || html.includes('__NEXT_DATA__') || html.includes('id="root"') || html.includes('id=__next'), 'not a Next shell');
    ok('GET / HTML', `bytes=${html.length}`);
  } catch (e) {
    fail('GET / HTML', e.message || e);
  }

  // Episode bootstrap (what UI does on load)
  try {
    const r = await fetch(`${BASE}/api/episodes/ensure-default`, { method: 'POST' });
    assert(r.ok, `ensure-default ${r.status}`);
    const data = await r.json();
    const episodeId = data.episode?.id || data.id || data.episodeId || data.episodes?.[0]?.id;
    assert(episodeId, 'no episode');
    ok('ensure-default episode', episodeId.slice(0, 12));

    const ep = await fetch(`${BASE}/api/episodes/${episodeId}`);
    assert(ep.ok, `episode ${ep.status}`);
    ok('GET episode', String(ep.status));

    // Agent task + workspace kind (UI panel contract)
    const createTask = await fetch(`${BASE}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        episodeId,
        goal: 'Скажи коротко: UI smoke ok',
        autoStart: false,
        maxSteps: 2,
        maxDurationSec: 60,
      }),
    });
    assert(createTask.ok, `create ${createTask.status}`);
    const { task } = await createTask.json();
    assert(task?.fsScope, 'task.fsScope missing');
    ok('create agent task', `${task.id.slice(0, 8)} fsScope=${String(task.fsScope).slice(-40)}`);

    const ws = await fetch(`${BASE}/api/agent/${task.id}/workspace`);
    assert(ws.ok, `workspace ${ws.status}`);
    const wsData = await ws.json();
    assert(wsData.hasWorkspace === true, 'hasWorkspace false');
    assert(wsData.kind === 'project', `expected kind=project got ${wsData.kind}`);
    assert(typeof wsData.label === 'string' && wsData.label.length > 0, 'missing label');
    assert(Array.isArray(wsData.tree) && wsData.tree.length > 0, 'empty tree');
    const names = wsData.tree.map((n) => n.name);
    assert(names.includes('src') || names.includes('package.json') || names.includes('README.md'),
      `unexpected tree roots: ${names.slice(0, 8).join(',')}`);
    ok('workspace panel API', `kind=${wsData.kind} label=${wsData.label} nodes=${wsData.tree.length}`);

    // Read a known file via workspace (file viewer)
    const file = await fetch(`${BASE}/api/agent/${task.id}/workspace?file=${encodeURIComponent('README.md')}`);
    assert(file.ok, `file ${file.status}`);
    const fileData = await file.json();
    assert(typeof fileData.fileContent === 'string' && fileData.fileContent.includes('Лия'), 'README.md content');
    ok('workspace file viewer', `README.md chars=${fileData.fileContent.length}`);

    await fetch(`${BASE}/api/agent/${task.id}/cancel`, { method: 'POST' });
    ok('cancel smoke task');
  } catch (e) {
    fail('episode/agent/workspace flow', e.message || e);
  }

  // Settings page SSR if exists
  for (const path of ['/settings', '/']) {
    try {
      const r = await fetch(`${BASE}${path}`);
      if (r.status === 404) {
        ok(`GET ${path}`, '404 skip');
        continue;
      }
      assert(r.ok, `${path} ${r.status}`);
      ok(`GET ${path}`, String(r.status));
    } catch (e) {
      fail(`GET ${path}`, e.message || e);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n---');
  console.log(`Passed ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(' FAIL', f.name, f.detail);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
