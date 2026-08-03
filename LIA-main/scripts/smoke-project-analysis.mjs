/**
 * Live smoke: project analysis of this Lia repo via agent.
 * Usage: node scripts/smoke-project-analysis.mjs
 */
import process from 'process';
import { writeFileSync } from 'fs';

const BASE = process.env.LIA_BASE_URL ?? 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function json(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 400)}`);
  return data;
}

async function main() {
  // Prefer gemma4 for agent
  const settings = await json('GET', '/api/settings');
  log('models available:', (settings.availableModels || []).join(', '));
  log('current agentModel:', settings.agentModelEffective ?? settings.agentModel ?? settings.model);
  const want = (settings.availableModels || []).find((m) => /^gemma4/i.test(m)) ?? 'gemma4:latest';
  await json('POST', '/api/settings', { agentModel: want });
  log('set agentModel →', want);

  const ep = await json('POST', '/api/episodes/ensure-default');
  const episodeId = ep.episodeId ?? ep.episodes?.[0]?.id;
  if (!episodeId) throw new Error('no episodeId');
  log('episode', episodeId);

  const goal =
    'Изучи репозиторий Lia-v2-public в рабочей директории (list_tree, file_search, read_file). ' +
    'Найди основные проблемы, риски и слабые места архитектуры/агента/памяти/KB. ' +
    'Не используй ask_user. Не заканчивай после пустого search_codebase — читай файлы с диска. ' +
    'В финале дай 5–10 конкретных проблем с путями к файлам.';

  const { task } = await json('POST', '/api/agent', {
    episodeId,
    goal,
    autoStart: true,
    template: 'reviewer',
    maxSteps: 18,
    maxDurationSec: 1800,
  });
  log('task', task.id, 'fsScope=', task.fsScope?.slice?.(-60) ?? task.fsScope);
  log('toolsWhitelist', task.toolsWhitelist);

  const start = Date.now();
  let lastStatus = '';
  let waitingAnswers = 0;
  while (Date.now() - start < 25 * 60_000) {
    const data = await json('GET', `/api/agent/${task.id}`);
    const t = data.task;
    const steps = data.steps || [];
    const last = steps.at(-1);
    const line = `${t.status} step=${t.currentStep} n=${steps.length} last=${last?.action || '-'}`;
    if (line !== lastStatus) {
      log(line);
      lastStatus = line;
    }

    if (t.status === 'waiting_input') {
      waitingAnswers++;
      if (waitingAnswers > 3) {
        console.log('too many waiting_input — aborting poll');
        break;
      }
      const answer =
        'Вызови tool прямо сейчас: read_file path="src/lib/agent/runner.ts" или file_search query="fsScope". Продолжай без вопросов.';
      await json('POST', `/api/agent/${task.id}/input`, { answer });
      log('answered waiting_input #', waitingAnswers);
    }

    if (['done', 'failed', 'cancelled'].includes(t.status)) {
      const summary = t.resultSummary || t.error || '';
      const actions = steps.map((s) => s.action);
      const out = {
        status: t.status,
        fsScope: t.fsScope,
        waitingAnswers,
        actions,
        summary,
        stepsPreview: steps.map((s) => ({
          action: s.action,
          obs: String(s.observation || '').slice(0, 180),
        })),
      };
      writeFileSync('tmp-project-analysis.json', JSON.stringify(out, null, 2), 'utf8');
      console.log('\n===== RESULT SUMMARY =====\n');
      console.log(summary.slice(0, 4000));
      console.log('\n===== ACTIONS =====\n', actions.join(' → '));
      console.log('\nsaved tmp-project-analysis.json');

      const usedFs = actions.some((a) => /list_tree|read_file|file_search|list_dir/.test(String(a)));
      const hasPaths = /src\/|CLAUDE\.md|runner|pipeline|kb-step/i.test(summary);
      const ok = t.status === 'done' && usedFs && summary.length > 200;
      console.log('\nPASS?', { ok, usedFs, hasPaths, summaryLen: summary.length });
      process.exit(ok ? 0 : 1);
    }

    await sleep(5000);
  }

  console.error('timeout');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
