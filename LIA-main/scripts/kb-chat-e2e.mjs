#!/usr/bin/env node
/**
 * KB full-cycle smoke: upload README → chat (auto) + agent → report.
 * Usage: node scripts/kb-chat-e2e.mjs
 */
const BASE = 'http://127.0.0.1:3000';

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function textPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { text, headers: Object.fromEntries(res.headers.entries()) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function uploadReadme() {
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const readmePath = path.join(root, 'README.md');

  const form = new FormData();
  form.append('name', 'Lia README');
  form.append('file', new Blob([fs.readFileSync(readmePath)], { type: 'text/markdown' }), 'README.md');

  const res = await fetch(`${BASE}/api/kb/sources/upload`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(`upload failed: ${JSON.stringify(data)}`);
  return data.source;
}

async function waitSourceReady(sourceId, maxSec = 180) {
  for (let i = 0; i < maxSec / 2; i++) {
    const { source } = await json('GET', `/api/kb/sources/${sourceId}`);
    process.stdout.write(`\r  indexing: ${source.status} (${source.chunkCount} chunks)   `);
    if (source.status === 'ready') { console.log(''); return source; }
    if (source.status === 'error') throw new Error(source.errorMessage);
    await sleep(2000);
  }
  throw new Error('indexing timeout');
}

async function getEpisodeId() {
  await json('POST', '/api/episodes/ensure-default');
  const { episodes } = await json('GET', '/api/episodes');
  if (!episodes?.length) throw new Error('no episodes');
  return episodes[0].id;
}

async function chatAuto(episodeId, question) {
  const { text, headers } = await textPost('/api/chat', { text: question, episodeId, mode: 'auto' });
  if (headers['content-type']?.includes('application/json')) {
    const parsed = JSON.parse(text);
    return { type: 'agent_redirect', ...parsed };
  }
  return { type: 'stream', answer: text.trim(), messageId: headers['x-message-id'] };
}

async function runAgent(episodeId, goal, maxWaitSec = 300) {
  const { task } = await json('POST', '/api/agent', { episodeId, goal, autoStart: true });
  const taskId = task.id;
  const start = Date.now();

  while (Date.now() - start < maxWaitSec * 1000) {
    const data = await json('GET', `/api/agent/${taskId}`);
    const status = data.task.status;
    process.stdout.write(`\r  agent ${taskId.slice(0, 8)}: ${status} (step ${data.task.currentStep})   `);
    if (['done', 'failed', 'cancelled'].includes(status)) {
      console.log('');
      const steps = data.steps ?? [];
      const actions = steps.map(s => s.action).filter(Boolean);
      const usedKb = actions.some(a =>
        ['search_sources', 'get_source', 'list_sources', 'search_tickets', 'get_ticket']
          .some(t => a.includes(t)),
      );
      return {
        status,
        resultSummary: data.task.resultSummary,
        error: data.task.error,
        actions,
        usedKb,
        steps: steps.length,
      };
    }
    await sleep(3000);
  }
  throw new Error('agent timeout');
}

const AUTO_QUESTIONS = [
  'По README проекта Lia: какой фреймворк указан в разделе «Стек»?',
  'Что написано в README про Knowledge Base?',
  'Сколько инструментов у агента перечислено в README (включая KB tools)?',
];

const AGENT_QUESTIONS = [
  'Используй search_sources по базе знаний (документ README). Ответь: какой ORM и БД использует Lia v2? Укажи citation.',
  'search_sources: найди в README список KB tools. Перечисли их.',
  'search_sources по README: как установить и запустить Ollama по quickstart?',
];

function checkAnswer(label, answer, keywords) {
  const lower = (answer ?? '').toLowerCase();
  const hits = keywords.filter(k => lower.includes(k.toLowerCase()));
  return { label, ok: hits.length > 0, hits, preview: (answer ?? '').slice(0, 400) };
}

async function main() {
  console.log('=== KB full-cycle E2E ===\n');

  // Health
  const health = await json('GET', '/api/health');
  console.log(`Ollama: ${health.ok ? 'UP' : 'DOWN'}, model: ${health.model}`);

  // Upload README
  console.log('\n1. Upload README.md → KB');
  const source = await uploadReadme();
  console.log(`   sourceId: ${source.id}`);
  const ready = await waitSourceReady(source.id);
  console.log(`   ready: ${ready.chunkCount} chunks`);

  const episodeId = await getEpisodeId();
  console.log(`   episodeId: ${episodeId.slice(0, 12)}…`);

  // Auto mode
  console.log('\n2. Режим «Диалог» (auto) — 3 вопроса по README');
  const autoResults = [];
  for (const q of AUTO_QUESTIONS) {
    console.log(`\n   Q: ${q.slice(0, 70)}…`);
    const r = await chatAuto(episodeId, q);
    autoResults.push({ q, ...r });
    if (r.type === 'agent_redirect') {
      console.log(`   → auto-routed to agent: ${r.taskId}`);
    } else {
      console.log(`   A (${r.answer.length} chars): ${r.answer.slice(0, 200)}…`);
    }
  }

  // Agent mode
  console.log('\n3. Режим «Агент» — 3 вопроса через search_sources');
  const agentResults = [];
  for (const q of AGENT_QUESTIONS) {
    console.log(`\n   Q: ${q.slice(0, 70)}…`);
    const r = await runAgent(episodeId, q);
    agentResults.push({ q, ...r });
    console.log(`   status: ${r.status}, KB tool used: ${r.usedKb}, actions: ${r.actions.join(' → ') || 'none'}`);
    console.log(`   A: ${(r.resultSummary ?? r.error ?? '').slice(0, 250)}…`);
  }

  // Summary
  console.log('\n=== Проверка содержимого ответов ===\n');

  const checks = [];

  const auto0 = autoResults.find(r => r.q.includes('framework'))?.answer ?? autoResults[0]?.answer ?? '';
  checks.push(checkAnswer('Auto: Next.js в стеке', auto0, ['next.js', 'nextjs']));

  const auto1 = autoResults.find(r => r.q.includes('Knowledge Base'))?.answer ?? '';
  checks.push(checkAnswer('Auto: KB hybrid search', auto1, ['knowledge base', 'hybrid', 'bm25', 'база знан']));

  const agent0 = agentResults[0]?.resultSummary ?? '';
  checks.push(checkAnswer('Agent: Prisma/SQLite', agent0, ['prisma', 'sqlite']));

  const agent1 = agentResults[1]?.resultSummary ?? '';
  checks.push(checkAnswer('Agent: KB tools listed', agent1, ['search_sources', 'get_source', 'list_sources']));

  const agent2 = agentResults[2]?.resultSummary ?? '';
  checks.push(checkAnswer('Agent: ollama pull', agent2, ['ollama', 'pull', 'nomic']));

  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.label} (keywords: ${c.hits.join(', ') || 'none'})`);
  }

  const kbUsedInAgent = agentResults.every(r => r.usedKb);
  console.log(`\n${kbUsedInAgent ? '✓' : '✗'} Все agent-задачи вызвали KB tools`);

  console.log('\n=== NOTE ===');
  console.log('Режим «Диалог» (auto) НЕ имеет search_sources — KB доступна только в «Агент».');
  console.log('Это by design: KB tools только в agent ReAct loop.\n');
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
