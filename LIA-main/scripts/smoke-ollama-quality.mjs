#!/usr/bin/env node
/**
 * Full Ollama quality E2E (no mocks): chat + agent + artifact + KB.
 * Usage: node scripts/smoke-ollama-quality.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.LIA_BASE_URL ?? 'http://127.0.0.1:3000';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_MAX_WAIT_MS = Number(process.env.LIA_AGENT_WAIT_MS ?? 15 * 60_000);
const CHAT_TIMEOUT_MS = Number(process.env.LIA_CHAT_TIMEOUT_MS ?? 180_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() {
  return new Date().toISOString().slice(11, 19);
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

async function json(method, pathName, body) {
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${pathName} → ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

async function chatFull(episodeId, text, mode = 'auto') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, episodeId, mode }),
      signal: controller.signal,
    });
    const body = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) throw new Error(`chat ${res.status}: ${body.slice(0, 300)}`);
    if (ct.includes('application/json')) {
      return { type: 'agent_redirect', ...JSON.parse(body) };
    }
    return { type: 'stream', answer: body.trim(), status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function scoreKeywords(answer, keywords) {
  const lower = (answer ?? '').toLowerCase();
  const hits = keywords.filter((k) => lower.includes(k.toLowerCase()));
  return { hits, ok: hits.length > 0, ratio: hits.length / Math.max(1, keywords.length) };
}

async function cancelActive(episodeId) {
  const { tasks } = await json('GET', `/api/agent?episodeId=${episodeId}`);
  const active = (tasks ?? []).filter((t) => !['done', 'failed', 'cancelled'].includes(t.status));
  for (const t of active) {
    try {
      await fetch(`${BASE}/api/agent/${t.id}/cancel`, { method: 'POST' });
      log(`cancelled stale ${t.id.slice(0, 8)} (${t.status})`);
    } catch (e) {
      log(`cancel failed ${t.id.slice(0, 8)}: ${e.message}`);
    }
  }
}

async function runAgentUntilDone(episodeId, goal, opts = {}) {
  const {
    template = 'general',
    maxSteps = 15,
    maxDurationSec = 900,
    toolsWhitelist,
    waitInputAnswer = 'Задача уже выполнена по сути. Сейчас ответь одной строкой ровно: ГОТОВО: задача завершена. Без новых tool-calls.',
  } = opts;

  const { task } = await json('POST', '/api/agent', {
    episodeId,
    goal,
    autoStart: true,
    template,
    maxSteps,
    maxDurationSec,
    ...(toolsWhitelist ? { toolsWhitelist } : {}),
  });
  const taskId = task.id;
  log(`agent created ${taskId.slice(0, 8)} …`);

  const start = Date.now();
  let lastStatus = '';
  let waitingReplies = 0;

  while (Date.now() - start < AGENT_MAX_WAIT_MS) {
    const data = await json('GET', `/api/agent/${taskId}`);
    const t = data.task;
    const steps = data.steps ?? [];
    const last = steps[steps.length - 1];
    if (t.status !== lastStatus) {
      log(
        `  ${taskId.slice(0, 8)} → ${t.status} step=${t.currentStep} n=${steps.length}` +
          (last ? ` last=${last.action}` : ''),
      );
      lastStatus = t.status;
    }

    if (t.status === 'waiting_input') {
      waitingReplies += 1;
      if (waitingReplies > 8) {
        return {
          taskId,
          status: 'waiting_input',
          error: 'too many waiting_input loops',
          resultSummary: t.resultSummary,
          steps,
          actions: steps.map((s) => s.action),
          waitingReplies,
          elapsedMs: Date.now() - start,
        };
      }
      const ir = await fetch(`${BASE}/api/agent/${taskId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: waitInputAnswer }),
      });
      const irText = await ir.text();
      log(`  input reply #${waitingReplies} → ${ir.status} ${irText.slice(0, 80)}`);
    }

    if (['done', 'failed', 'cancelled'].includes(t.status)) {
      return {
        taskId,
        status: t.status,
        error: t.error,
        resultSummary: t.resultSummary,
        fsScope: t.fsScope,
        steps,
        actions: steps.map((s) => s.action),
        waitingReplies,
        elapsedMs: Date.now() - start,
      };
    }
    await sleep(4000);
  }

  return {
    taskId,
    status: 'timeout',
    error: 'agent timeout',
    resultSummary: null,
    steps: [],
    actions: [],
    waitingReplies,
    elapsedMs: Date.now() - start,
  };
}

async function uploadReadme() {
  // Prefer multipart upload (same path as UI). Fallback: create document source
  // with absolute README path if upload route is unavailable.
  const readmePath = path.join(ROOT, 'README.md');
  const form = new FormData();
  form.append('name', 'Lia README quality-e2e');
  form.append(
    'file',
    new Blob([fs.readFileSync(readmePath)], { type: 'text/markdown' }),
    'README.md',
  );
  const uploadRes = await fetch(`${BASE}/api/kb/sources/upload`, { method: 'POST', body: form });
  if (uploadRes.ok) {
    const uploaded = await uploadRes.json();
    return uploaded.source;
  }

  const stat = fs.statSync(readmePath);
  const data = await json('POST', '/api/kb/sources', {
    type: 'document',
    name: 'Lia README quality-e2e',
    config: {
      filePath: readmePath,
      mimeType: 'text/markdown',
      fileSize: stat.size,
      originalFilename: 'README.md',
    },
  });
  return data.source;
}

async function waitSourceReady(sourceId, maxSec = 240) {
  for (let i = 0; i < maxSec / 2; i++) {
    const { source } = await json('GET', `/api/kb/sources/${sourceId}`);
    process.stdout.write(`\r  indexing: ${source.status} (${source.chunkCount} chunks)   `);
    if (source.status === 'ready') {
      console.log('');
      return source;
    }
    if (source.status === 'error') throw new Error(source.errorMessage ?? 'index error');
    await sleep(2000);
  }
  throw new Error('indexing timeout');
}

async function main() {
  const report = { pass: [], fail: [], notes: [] };

  const mark = (ok, label, detail = '') => {
    (ok ? report.pass : report.fail).push({ label, detail });
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('══════════════════════════════════════════════');
  console.log(' Lia v2 — Full Ollama Quality E2E (no mocks)');
  console.log('══════════════════════════════════════════════\n');

  const health = await json('GET', '/api/health');
  const settings = await json('GET', '/api/settings');
  log(`Ollama ok=${health.ok} model=${settings.model} provider=${settings.provider}`);
  mark(health.ok === true && settings.provider === 'ollama', 'Ollama provider live', `${settings.model}`);
  mark(Array.isArray(health.models) && health.models.length > 0, 'Models listed from Ollama');

  const epEnsure = await json('POST', '/api/episodes/ensure-default');
  const episodeId = epEnsure.episodeId ?? epEnsure.episodes?.[0]?.id;
  if (!episodeId) throw new Error('no episodeId');
  log(`episodeId=${episodeId}`);
  await cancelActive(episodeId);

  // ─── CHAT ─────────────────────────────────────────────
  console.log('\n── CHAT ───────────────────────────────────────');

  const chat1 = await chatFull(
    episodeId,
    'Ответь на русском, 2–3 предложения: кто ты, чем отличаешься от обычного чат-бота, и что умеешь в режиме агента.',
    'auto',
  );
  if (chat1.type === 'stream') {
    log(`chat1 (${chat1.answer.length} chars): ${chat1.answer.slice(0, 220)}`);
    const s = scoreKeywords(chat1.answer, ['лия', 'агент', 'код', 'помощ']);
    mark(chat1.answer.length >= 40 && s.ok, 'Chat identity (auto)', `hits=${s.hits.join(',')}`);
  } else {
    mark(false, 'Chat identity (auto)', `unexpected redirect ${JSON.stringify(chat1).slice(0, 120)}`);
  }

  const chat2 = await chatFull(
    episodeId,
    'Кратко и по делу: чем отличаются режимы «диалог» и «агент» у тебя? Один абзац.',
    'fast',
  );
  if (chat2.type === 'stream') {
    log(`chat2 (${chat2.answer.length} chars): ${chat2.answer.slice(0, 220)}`);
    const s = scoreKeywords(chat2.answer, ['агент', 'инструмент']);
    mark(chat2.answer.length >= 30 && s.ratio >= 0.5, 'Chat modes explanation (fast)', `hits=${s.hits.join(',')}`);
  } else {
    mark(false, 'Chat modes explanation (fast)', 'redirect');
  }

  const chat3 = await chatFull(
    episodeId,
    'Реши без инструментов: сколько будет 17*19? Сначала кратко покажи рассуждение, потом ответ числом.',
    'auto',
  );
  if (chat3.type === 'stream') {
    log(`chat3: ${chat3.answer.slice(0, 260)}`);
    const has323 = /\b323\b/.test(chat3.answer);
    mark(has323, 'Chat arithmetic reasoning', has323 ? '323 ok' : chat3.answer.slice(0, 120));
  } else {
    mark(false, 'Chat arithmetic reasoning', 'redirect');
  }

  // ─── AGENT: file tool ─────────────────────────────────
  console.log('\n── AGENT: write_file ──────────────────────────');
  const stamp = Date.now();
  const fileName = `quality-${stamp}.txt`;
  const expectedLine = `Lia Ollama quality OK ${stamp}`;
  const fileGoal =
    `Сделай ровно следующее и остановись:\n` +
    `1) Вызови write_file с path="${fileName}" и content="${expectedLine}"\n` +
    `2) Сразу после успешной записи ответь текстом одной строкой: ГОТОВО: файл ${fileName} создан\n` +
    `Не вызывай web_search. Не спрашивай пользователя. Не делай повторных reason.`;

  const agentFile = await runAgentUntilDone(episodeId, fileGoal, {
    template: 'coder',
    maxSteps: 10,
    maxDurationSec: 600,
  });
  log(`file-agent status=${agentFile.status} actions=${agentFile.actions.join(' → ')} wait=${agentFile.waitingReplies} ${Math.round(agentFile.elapsedMs / 1000)}s`);
  mark(agentFile.status === 'done', 'Agent file task reaches done', agentFile.error ?? agentFile.status);
  mark(
    (agentFile.actions ?? []).some((a) => String(a).includes('write_file')),
    'Agent used write_file',
    agentFile.actions.join(',') || 'none',
  );

  let fileOk = false;
  if (agentFile.fsScope) {
    const p = path.join(agentFile.fsScope, fileName);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8').trim();
      fileOk = content === expectedLine;
      mark(fileOk, 'Artifact on disk matches expected', content.slice(0, 80));
    } else {
      mark(false, 'Artifact on disk matches expected', `missing ${p}`);
    }
  } else {
    mark(false, 'Artifact on disk matches expected', 'no fsScope');
  }

  const summaryHits = scoreKeywords(agentFile.resultSummary ?? '', [fileName, 'готово', 'файл', 'создан']);
  mark(
    agentFile.status === 'done' && (summaryHits.ok || fileOk),
    'Agent synthesis mentions result',
    (agentFile.resultSummary ?? '').slice(0, 160),
  );

  // ─── AGENT: research plan ─────────────────────────────
  console.log('\n── AGENT: research/plan ───────────────────────');
  const planGoal =
    'Составь короткий план подготовки к собеседованию по TypeScript из ровно 3 нумерованных шагов. ' +
    'Можно использовать web_search один раз, если нужно. ' +
    'Когда план готов — ответь одной строкой: ГОТОВО: план из 3 шагов. ' +
    'Не спрашивай пользователя.';

  const agentPlan = await runAgentUntilDone(episodeId, planGoal, {
    template: 'researcher',
    maxSteps: 12,
    maxDurationSec: 700,
    waitInputAnswer:
      'План уже достаточно хороший. Не ищи больше. Ответь одной строкой: ГОТОВО: план из 3 шагов.',
  });
  log(`plan-agent status=${agentPlan.status} actions=${agentPlan.actions.join(' → ')} ${Math.round(agentPlan.elapsedMs / 1000)}s`);
  mark(agentPlan.status === 'done', 'Agent plan task reaches done', agentPlan.error ?? agentPlan.status);
  const planText = agentPlan.resultSummary ?? '';
  const planScore = scoreKeywords(planText, ['1', '2', '3', 'typescript']);
  mark(
    agentPlan.status === 'done' && planText.length >= 80 && (planScore.hits.includes('typescript') || /typescript/i.test(planText)),
    'Agent plan quality (TypeScript + structure)',
    planText.slice(0, 220),
  );

  // ─── KB upload + agent search ─────────────────────────
  console.log('\n── KB + AGENT search_sources ──────────────────');
  let kbSource = null;
  try {
    kbSource = await uploadReadme();
    log(`uploaded source ${kbSource.id.slice(0, 8)}`);
    const ready = await waitSourceReady(kbSource.id);
    mark(ready.chunkCount > 0, 'KB README indexed', `${ready.chunkCount} chunks`);
  } catch (e) {
    mark(false, 'KB README indexed', e.message);
  }

  if (kbSource) {
    const kbGoal =
      'Используй search_sources по базе знаний (документ README / Lia). ' +
      'Ответь: какой стек указан (фреймворк + БД/ORM). Укажи citation. ' +
      'После нахождения ответа сразу напиши: ГОТОВО: стек найден. Не спрашивай пользователя.';

    const agentKb = await runAgentUntilDone(episodeId, kbGoal, {
      template: 'researcher',
      maxSteps: 12,
      maxDurationSec: 700,
      toolsWhitelist: ['search_sources', 'get_source', 'list_sources', 'ask_user'],
      waitInputAnswer:
        'Если уже есть находка из search_sources — ответь: ГОТОВО: стек найден. Иначе сделай один search_sources и заверши.',
    });
    log(`kb-agent status=${agentKb.status} actions=${agentKb.actions.join(' → ')} ${Math.round(agentKb.elapsedMs / 1000)}s`);
    mark(agentKb.status === 'done', 'KB agent reaches done', agentKb.error ?? agentKb.status);
    const usedKb = (agentKb.actions ?? []).some((a) =>
      ['search_sources', 'get_source', 'list_sources', 'read_folder_file'].some((t) => String(a).includes(t)),
    );
    mark(usedKb, 'KB agent used KB tools', agentKb.actions.join(',') || 'none');
    const kbAns = agentKb.resultSummary ?? '';
    const kbScore = scoreKeywords(kbAns, ['next', 'prisma', 'sqlite']);
    mark(
      agentKb.status === 'done' && kbScore.hits.length >= 1,
      'KB agent answer quality (stack facts)',
      `hits=${kbScore.hits.join(',')} | ${kbAns.slice(0, 200)}`,
    );
  }

  // ─── Summary ──────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(` PASS: ${report.pass.length}   FAIL: ${report.fail.length}`);
  console.log('══════════════════════════════════════════════');
  if (report.fail.length) {
    console.log('\nFailures:');
    for (const f of report.fail) console.log(` - ${f.label}: ${f.detail}`);
  }
  if (report.fail.length) process.exit(1);
  console.log('\nAll quality checks passed on live Ollama.');
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
