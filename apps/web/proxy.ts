import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from './lib/csp';

/**
 * Per-request nonce-based Content Security Policy for every page (ASVS V3.4.3). API, SCIM, global and
 * mock identity provider paths are proxied or served by the API, which sets its own headers; static
 * assets get the fixed policy from next.config.ts.
 */
/**
 * Honey endpoints on the web host (ADR-0179): no page of the app lives at these paths, so a request for one is
 * a scanner. It is handed to the API's honey route, which raises a detection, waits and answers 404.
 */
export const WEB_HONEY_PATHS: Record<string, string> = {
  '/.env': 'env',
  '/wp-login.php': 'wp-login',
  '/.git/config': 'git-config',
};

export function proxy(request: NextRequest) {
  const honey = WEB_HONEY_PATHS[request.nextUrl.pathname];
  if (honey) return NextResponse.rewrite(new URL(`/v1/honey/${honey}`, request.url));
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
