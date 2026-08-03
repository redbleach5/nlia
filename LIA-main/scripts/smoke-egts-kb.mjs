#!/usr/bin/env node
/**
 * EGTS KB quality check:
 * 1) index EGTS docx into KB
 * 2) agent: find EGTS protocol description
 * 3) agent/chat: details on EGTS_SR_ADAS_DATA = 245
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.LIA_BASE_URL ?? 'http://127.0.0.1:3000';
const EGTS_DOCX = path.join('C:/Users/User/Desktop', 'Описание протокола EGTS 05_03_2026.docx');
const AGENT_WAIT_MS = 12 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${now()}]`, ...a);

async function json(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

async function waitSourceReady(sourceId, maxSec = 300) {
  for (let i = 0; i < maxSec / 2; i++) {
    const { source } = await json('GET', `/api/kb/sources/${sourceId}`);
    process.stdout.write(`\r  indexing: ${source.status} (${source.chunkCount} chunks)   `);
    if (source.status === 'ready') { console.log(''); return source; }
    if (source.status === 'error') throw new Error(source.errorMessage ?? 'index error');
    await sleep(2000);
  }
  throw new Error('indexing timeout');
}

async function runAgent(episodeId, goal, opts = {}) {
  const {
    template = 'researcher', // should be overridden by KB auto-whitelist
    maxSteps = 12,
    maxDurationSec = 700,
    // undefined → exercise control-plane auto KB whitelist
    toolsWhitelist,
    waitInputAnswer = 'Используй search_sources / get_source по KB и заверши ответом ГОТОВО: …',
  } = opts;

  const body = {
    episodeId,
    goal,
    autoStart: true,
    template,
    maxSteps,
    maxDurationSec,
  };
  if (toolsWhitelist) body.toolsWhitelist = toolsWhitelist;

  const { task } = await json('POST', '/api/agent', body);
  const taskId = task.id;
  let whitelist = null;
  try { whitelist = task.toolsWhitelist ? JSON.parse(task.toolsWhitelist) : null; } catch { /* ignore */ }
  log(`agent ${taskId.slice(0, 8)} created whitelist=${whitelist ? whitelist.join(',') : 'null'}`);

  const start = Date.now();
  let waiting = 0;
  let last = '';
  while (Date.now() - start < AGENT_WAIT_MS) {
    const data = await json('GET', `/api/agent/${taskId}`);
    const t = data.task;
    const steps = data.steps ?? [];
    if (t.status !== last) {
      log(`  ${taskId.slice(0, 8)} → ${t.status} step=${t.currentStep} n=${steps.length} last=${steps.at(-1)?.action ?? '-'}`);
      last = t.status;
    }
    if (t.status === 'waiting_input') {
      waiting += 1;
      if (waiting > 5) {
        return { taskId, status: 'waiting_input', error: 'too many waiting_input', resultSummary: t.resultSummary, actions: steps.map((s) => s.action), steps, waiting, elapsedMs: Date.now() - start, whitelist };
      }
      await fetch(`${BASE}/api/agent/${taskId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: waitInputAnswer }),
      });
    }
    if (['done', 'failed', 'cancelled'].includes(t.status)) {
      return {
        taskId,
        status: t.status,
        error: t.error,
        resultSummary: t.resultSummary,
        actions: steps.map((s) => s.action),
        steps,
        waiting,
        elapsedMs: Date.now() - start,
        whitelist,
      };
    }
    await sleep(4000);
  }
  return { taskId, status: 'timeout', error: 'timeout', actions: [], steps: [], waiting, elapsedMs: Date.now() - start, whitelist };
}

function score(text, keywords) {
  const lower = (text ?? '').toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

async function main() {
  console.log('══ EGTS KB scenario (live Ollama) ══\n');
  if (!fs.existsSync(EGTS_DOCX)) throw new Error(`EGTS doc missing: ${EGTS_DOCX}`);
  const st = fs.statSync(EGTS_DOCX);
  log(`docx size=${st.size}`);

  const health = await json('GET', '/api/health');
  log(`ollama=${health.ok} model=${health.model}`);

  // Reuse ready EGTS source if present; otherwise index docx
  console.log('\n1) Ensure EGTS docx in KB');
  const { sources } = await json('GET', '/api/kb/sources');
  let ready = (sources ?? []).find((s) =>
    s.status === 'ready' && s.chunkCount > 0 && /EGTS/i.test(s.name ?? ''),
  );
  if (ready) {
    log(`reuse source ${ready.id.slice(0, 8)} chunks=${ready.chunkCount}`);
  } else {
    const created = await json('POST', '/api/kb/sources', {
      type: 'document',
      name: 'Описание протокола EGTS',
      config: {
        filePath: EGTS_DOCX,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSize: st.size,
        originalFilename: path.basename(EGTS_DOCX),
      },
    });
    log(`sourceId=${created.source.id}`);
    ready = await waitSourceReady(created.source.id);
    log(`ready chunks=${ready.chunkCount}`);
  }
  if (!ready?.chunkCount) throw new Error('0 chunks after index');

  const ep = await json('POST', '/api/episodes/ensure-default');
  const episodeId = ep.episodeId ?? ep.episodes?.[0]?.id;

  // Cancel active tasks
  const { tasks } = await json('GET', `/api/agent?episodeId=${episodeId}`);
  for (const t of (tasks ?? []).filter((x) => !['done', 'failed', 'cancelled'].includes(x.status))) {
    await fetch(`${BASE}/api/agent/${t.id}/cancel`, { method: 'POST' }).catch(() => null);
  }

  // Step A: find EGTS protocol description
  console.log('\n2) Agent: find EGTS protocol description');
  const a = await runAgent(
    episodeId,
    'Найди описание протокола EGTS в базе знаний. Кратко перескажи, что это за протокол (назначение, основные сущности). Укажи citation. Затем ответь: ГОТОВО: описание EGTS найдено.',
    { waitInputAnswer: 'Если уже есть текст из search_sources — ответь ГОТОВО: описание EGTS найдено.' },
  );
  log(`A status=${a.status} wait=${a.waiting} ${Math.round(a.elapsedMs / 1000)}s actions=${a.actions.join('→')}`);
  console.log('A summary:\n', (a.resultSummary ?? a.error ?? '').slice(0, 900));
  const aHits = score(a.resultSummary ?? '', ['egts', 'протокол', 'транспорт', 'навигац', 'телематик', 'пакет', 'сервис']);
  const aUsedKb = (a.actions ?? []).some((x) => /search_sources|get_source|read_folder_file/.test(String(x)));
  const aNoCodebase = !(a.actions ?? []).some((x) => /search_codebase|web_search/.test(String(x)));
  const aNoHalluc = !/european\s+trolleybus|trolleybus system/i.test(a.resultSummary ?? '');
  const aAutoWl = Array.isArray(a.whitelist) && a.whitelist.includes('search_sources') && !a.whitelist.includes('search_codebase');
  console.log(`A checks: done=${a.status === 'done'} usedKb=${aUsedKb} noWeb/code=${aNoCodebase} autoWl=${aAutoWl} noHalluc=${aNoHalluc} hits=${aHits.join(',')}`);

  // Step B: details on EGTS_SR_ADAS_DATA = 245
  console.log('\n3) Agent: EGTS_SR_ADAS_DATA = 245');
  const b = await runAgent(
    episodeId,
    'В базе знаний найди и расскажи подробнее про EGTS_SR_ADAS_DATA = 245 (что это за запись/подзапись, поля, назначение). Используй search_sources с query EGTS_SR_ADAS_DATA. Только факты из KB, без выдумок. В конце: ГОТОВО: EGTS_SR_ADAS_DATA разобран.',
    {
      waitInputAnswer: 'Сделай search_sources по EGTS_SR_ADAS_DATA и заверши ГОТОВО: EGTS_SR_ADAS_DATA разобран.',
    },
  );
  log(`B status=${b.status} wait=${b.waiting} ${Math.round(b.elapsedMs / 1000)}s actions=${b.actions.join('→')}`);
  console.log('B summary:\n', (b.resultSummary ?? b.error ?? '').slice(0, 1200));
  const bHits = score(b.resultSummary ?? '', ['245', 'adas', 'egts_sr_adas', 'подзапис', 'teledata', 'mobileye', 'movon', 'таблица']);
  const bUsedKb = (b.actions ?? []).some((x) => /search_sources|get_source|read_folder_file/.test(String(x)));
  const bNoHalluc = !/european\s+trolleybus|trolleybus system/i.test(b.resultSummary ?? '');
  console.log(`B checks: done=${b.status === 'done'} usedKb=${bUsedKb} noHalluc=${bNoHalluc} hits=${bHits.join(',')}`);

  const pass =
    a.status === 'done' && aUsedKb && aHits.length >= 1 && aNoCodebase && aAutoWl && aNoHalluc &&
    b.status === 'done' && bUsedKb && bNoHalluc && (bHits.includes('adas') || bHits.includes('egts_sr_adas') || bHits.includes('245'));

  console.log('\n════════════════════════════════');
  console.log(pass ? 'PASS: EGTS scenario OK (routing + groundedness)' : 'FAIL: EGTS scenario incomplete');
  console.log('════════════════════════════════');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
