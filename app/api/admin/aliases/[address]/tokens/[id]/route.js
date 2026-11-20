import { requireAdmin, revokeAliasToken } from '@/lib/server/runtime';
import { respond, handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request, { params }) {
  try {
    await requireAdmin(request);
    return respond(await revokeAliasToken(params.address, params.id), {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return handleError(err);
  }
}
