import {
  createAliasToken,
  listAliasTokens,
  requireAdmin
} from '@/lib/server/runtime';
import { respond, handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  try {
    await requireAdmin(request);
    return respond(await listAliasTokens(params.address), {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request, { params }) {
  try {
    await requireAdmin(request);
    return respond(await createAliasToken(params.address), {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return handleError(err);
  }
}
