/**
 * Server-Sent Events (SSE) endpoint for real-time inbox updates.
 *
 * Frontend connects to this endpoint and receives "newmail" events
 * when Gmail push notification arrives. This eliminates polling delay.
 *
 * Usage in frontend after establishing an access session:
 *   const es = new EventSource('/api/messages/stream');
 *   es.addEventListener('newmail', () => refreshInbox());
 */

import { requireAccessSession, subscribeNewMail, unsubscribeNewMail } from '@/lib/server/runtime';
import { handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  let session;
  try {
    session = await requireAccessSession(request);
  } catch (err) {
    const response = handleError(err);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));

      // Keep-alive every 25 seconds to prevent timeout
      const keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepAlive);
        }
      }, 25000);

      // Subscribe to new mail notifications
      const listener = (payload) => {
        if (closed) return;
        if (payload?.tokenId !== session.tokenId) return;
        try {
          controller.enqueue(
            encoder.encode(`event: newmail\ndata: ${JSON.stringify(payload || {})}\n\n`)
          );
        } catch {
          // Client disconnected
        }
      };

      subscribeNewMail(listener);

      // Cleanup on abort
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(keepAlive);
        unsubscribeNewMail(listener);
        try { controller.close(); } catch {}
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    }
  });
}
