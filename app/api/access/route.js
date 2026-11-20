import { NextResponse } from 'next/server';
import {
  checkAccessRateLimit,
  createAccessSession,
  getAccessCookieOptions,
  requireAccessSession
} from '@/lib/server/runtime';
import { handleError } from '@/lib/server/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(response) {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request) {
  try {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      request.headers.get('x-real-ip') || 'unknown';
    checkAccessRateLimit(ip);
    const body = await request.json().catch(() => ({}));
    const session = await createAccessSession(body?.token);
    const response = NextResponse.json({ alias: session.alias, expiresAt: session.expiresAt });
    response.cookies.set({ ...getAccessCookieOptions(), value: session.cookieValue });
    return noStore(response);
  } catch (err) {
    return noStore(handleError(err));
  }
}

export async function GET(request) {
  try {
    const session = await requireAccessSession(request);
    return noStore(NextResponse.json({ authenticated: true, ...session }));
  } catch (err) {
    if (err?.status === 401) {
      return noStore(NextResponse.json({ authenticated: false }));
    }
    return noStore(handleError(err));
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...getAccessCookieOptions(), value: '', maxAge: 0 });
  return noStore(response);
}
