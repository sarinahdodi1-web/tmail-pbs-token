import { listMessages, requireAccessSession } from '@/lib/server/runtime';
import { respond, handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const session = await requireAccessSession(request);
    const payload = await listMessages(session.alias, { tokenId: session.tokenId });
    return respond(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const response = handleError(err);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
