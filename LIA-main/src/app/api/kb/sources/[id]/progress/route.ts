// GET /api/kb/sources/[id]/progress — SSE для real-time indexing progress
//
// Server-Sent Events stream. Клиент подписывается:
//   const es = new EventSource('/api/kb/sources/{id}/progress');
//   es.onmessage = (e) => { const data = JSON.parse(e.data); ... };
//
// Отправляет events из indexEvents EventEmitter (см. indexer.ts):
//   { phase, processed, total, percent, errorMessage? }
//
// Stream закрывается когда:
//   - phase === 'done' или 'error' (финальное событие)
//   - клиент отключается (req.signal.aborted)
//   - timeout 10 минут (safety net для зависших соединений)

import { NextRequest } from 'next/server';
import { indexEvents, type IndexProgress } from '@/lib/kb/indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_STREAM_DURATION_MS = 10 * 60 * 1000;  // 10 min safety net

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
          closed = true;
        }
      };

      // Send initial connection confirmation
      send({ type: 'connected', sourceId: id });

      // Listen for progress events for THIS sourceId
      const onProgress = (event: IndexProgress) => {
        if (event.sourceId !== id) return;
        send(event);

        // Close stream on terminal phases
        if (event.phase === 'done' || event.phase === 'error') {
          closed = true;
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }
      };

      indexEvents.on('progress', onProgress);

      // Cleanup function — `let` so we can wrap it below (P2-9 fix T-63).
      let cleanup = () => {
        indexEvents.off('progress', onProgress);
      };

      // Client disconnect
      req.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });

      // Safety net: force-close after MAX_STREAM_DURATION
      // P2-9 fix (T-63): store the timeout ID and clear it in cleanup() so the
      // timer doesn't hold a closure reference to `controller` for 10 min
      // after the stream closes naturally.
      const safetyTimeoutId = setTimeout(() => {
        if (closed) return;
        closed = true;
        cleanup();
        send({ type: 'timeout', message: 'Stream closed after 10 min' });
        try { controller.close(); } catch { /* already closed */ }
      }, MAX_STREAM_DURATION_MS);

      // Override cleanup to also clear the safety timeout.
      const originalCleanup = cleanup;
      cleanup = () => {
        clearTimeout(safetyTimeoutId);
        originalCleanup();
      };
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Disable Next.js buffering for SSE
      'X-Accel-Buffering': 'no',
    },
  });
}
