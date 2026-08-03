import process from 'process';

const baseUrl = process.env.LIA_BASE_URL ?? 'http://localhost:3000';
const episodeEnsureUrl = `${baseUrl}/api/episodes/ensure-default`;
const chatUrl = `${baseUrl}/api/chat`;
const agentUrl = `${baseUrl}/api/agent`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readFirstChunk(res, controller, maxBytes = 6000) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let acc = '';
  try {
    const { value, done } = await reader.read();
    if (done) return acc;
    acc += decoder.decode(value, { stream: false });
    if (acc.length > maxBytes) acc = acc.slice(0, maxBytes);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    // Cancel the underlying HTTP request so the process can exit.
    try { controller?.abort(); } catch { /* ignore */ }
  }
  return acc;
}

async function main() {
  console.log(`Base URL: ${baseUrl}`);

  // 1) Ensure default episode
  const epRes = await fetch(episodeEnsureUrl, { method: 'POST' });
  if (!epRes.ok) throw new Error(`ensure-default failed: ${epRes.status}`);
  const epJson = await epRes.json();
  const episodeId = epJson.episodeId ?? epJson.episodes?.[0]?.id ?? null;
  if (!episodeId) throw new Error(`episodeId missing in: ${JSON.stringify(epJson)}`);
  console.log(`episodeId: ${episodeId}`);

  // 2) Chat smoke
  const chatBody = {
    text: 'Привет! Скажи кратко: ты кто и чем полезен?',
    episodeId,
    mode: 'auto',
  };
  const chatRes = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody),
  });
  console.log(`chat status: ${chatRes.status} ${chatRes.headers.get('content-type') ?? ''}`);

  // The response is typically streamed. We read only the first chunk.
  const chatAbort = new AbortController();
  const chatChunk = await readFirstChunk(chatRes, chatAbort);
  console.log(`chat first chunk (first 300 chars):\n${chatChunk.slice(0, 300)}`);

  // If server decides to auto-route to agent mode, it may return JSON.
  // We'll detect that, but we don't need to parse it further for smoke.
  const maybeJson = chatChunk.trim().startsWith('{') ? chatChunk.trim() : '';
  if (maybeJson) {
    console.log('chat returned JSON (auto-agent routing possible).');
  }

  // 3) Agent smoke (create task + read initial SSE event)
  const agentBody = {
    episodeId,
    goal: 'Составь короткий план из 3 шагов: как подготовиться к собеседованию по TypeScript.',
    autoStart: true,
    template: 'general',
  };
  const agentCreateRes = await fetch(agentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentBody),
  });
  if (!agentCreateRes.ok) {
    throw new Error(`agent create failed: ${agentCreateRes.status} ${await agentCreateRes.text().catch(() => '')}`);
  }
  const agentCreateJson = await agentCreateRes.json();
  const task = agentCreateJson.task;
  if (!task?.id) throw new Error(`task.id missing in: ${JSON.stringify(agentCreateJson)}`);
  const taskId = task.id;
  console.log(`agent taskId: ${taskId}`);

  // Read first SSE chunk
  const streamRes = await fetch(`${baseUrl}/api/agent/${taskId}/stream`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  });
  console.log(`agent stream status: ${streamRes.status}`);

  const sseAbort = new AbortController();
  const sseChunk = await readFirstChunk(streamRes, sseAbort);
  console.log(`agent stream first chunk (first 500 chars):\n${sseChunk.slice(0, 500)}`);

  if (!sseChunk.includes('event:')) {
    console.warn('WARNING: SSE chunk did not include expected "event:" prefix.');
  } else {
    console.log('SSE appears to be working (event prefix found).');
  }

  // Give server a moment to enqueue some events (not required, but helps stability)
  await sleep(300);
  console.log('Smoke check done.');
}

main().catch((e) => {
  console.error('Smoke check failed:', e);
  process.exit(1);
});

