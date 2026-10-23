import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from './lib/csp';

/**
 * Per-request nonce-based Content Security Policy for every page (ASVS V3.4.3). API, SCIM, global and
 * mock identity provider paths are proxied or served by the API, which sets its own headers; static
 * assets get the fixed policy from next.config.ts.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|v1/|scim/|global/|__mock-idp|fonts/|icons/|sw\\.js$|favicon\\.ico$).*)',
  ],
};
