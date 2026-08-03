import process from 'process';

const baseUrl = process.env.LIA_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const epRes = await fetch(`${baseUrl}/api/episodes/ensure-default`, { method: 'POST' });
  const epJson = await epRes.json();
  const episodeId = epJson.episodeId ?? epJson.episodes?.[0]?.id ?? null;
  if (!episodeId) throw new Error('episodeId missing');

  const agentCreateRes = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      episodeId,
      goal: 'Коротко: поприветствуй пользователя и предложи план на 1 шаг.',
      autoStart: true,
      template: 'general',
      maxSteps: 3,
      maxDurationSec: 120,
    }),
  });
  if (!agentCreateRes.ok) throw new Error(`agent create failed: ${agentCreateRes.status}`);
  const agentCreateJson = await agentCreateRes.json();
  const taskId = agentCreateJson.task?.id;
  if (!taskId) throw new Error(`taskId missing in: ${JSON.stringify(agentCreateJson)}`);

  console.log(`agent taskId: ${taskId}`);

  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const taskRes = await fetch(`${baseUrl}/api/agent/${taskId}`);
    if (!taskRes.ok) throw new Error(`agent get failed: ${taskRes.status}`);
    const taskJson = await taskRes.json();
    const task = taskJson.task;
    console.log(`status: ${task?.status}, step: ${task?.currentStep}`);
    if (task?.status === 'done' || task?.status === 'failed' || task?.status === 'cancelled') {
      console.log('terminal status reached.');
      return;
    }
    await sleep(2000);
  }

  console.warn('timeout: status did not reach done/failed within 30s');
}

main().catch((e) => {
  console.error('Smoke agent poll failed:', e);
  process.exit(1);
});

