import { headers } from 'next/headers';
import type { SessionInfo } from './api';

/**
 * The signed-in session, read by the web server from the API so app pages render with it in the
 * first HTML instead of waiting for a browser round trip. API_INTERNAL_URL is the API's private
 * Service Connect address in AWS; API_PROXY_URL is the local and e2e API. Returns null when neither
 * is set, there is no cookie, or the API does not answer quickly: the shell then fetches the session
 * in the browser as before.
 */
export async function serverSession(): Promise<SessionInfo | null> {
  const base = process.env.API_INTERNAL_URL ?? process.env.API_PROXY_URL;
  if (!base) return null;
  const h = await headers();
  const cookie = h.get('cookie');
  if (!cookie) return null;
  try {
    const res = await fetch(`${base}/v1/auth/session`, {
      headers: { cookie, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as SessionInfo) : null;
  } catch {
    return null;
  }
}
