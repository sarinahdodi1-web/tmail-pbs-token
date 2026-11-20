import { requireAdmin, rotateAliasAccessToken } from '@/lib/server/runtime';
import { respond, handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  try {
    await requireAdmin(request);
    return respond(await rotateAliasAccessToken(params.address));
  } catch (err) {
    return handleError(err);
  }
}
