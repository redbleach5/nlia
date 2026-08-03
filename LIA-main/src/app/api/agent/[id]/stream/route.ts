// GET /api/agent/[id]/stream — SSE for real-time task updates.

import { NextRequest } from 'next/server';
import { subscribeToTask, getBufferedEvents, type AgentEvent } from '@/lib/agent/events';
import { getAgentTask } from '@/lib/agent/task';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const task = await getAgentTask(id);
  if (!task) {
    return new Response('task not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  const unsubscribers: Array<() => void> = [];
  let closed = false;
  let cleanup: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      safeEnqueue(encoder.encode(`event: task_init\ndata: ${JSON.stringify(task)}\n\n`));

      const buffered = getBufferedEvents(id);
      for (const evt of buffered) {
        if (!safeEnqueue(encoder.encode(formatSSE(evt)))) break;
      }

      const unsubParent = subscribeToTask(id, (event: AgentEvent) => {
        safeEnqueue(encoder.encode(formatSSE(event)));
      });
      unsubscribers.push(unsubParent);

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`:heartbeat\n\n`));
      }, 15_000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        for (const unsub of unsubscribers) {
          try { unsub(); } catch { /* ignore */ }
        }
        unsubscribers.length = 0;
        clearInterval(heartbeat);
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function formatSSE(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
