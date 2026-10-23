import { headers } from 'next/headers';

/**
 * A GET to the API made by the web server with the viewer's cookie, so a page can render with its
 * first data in the HTML instead of fetching it after hydration (the same path as serverSession).
 * Returns undefined when the API is not configured, refuses, or does not answer quickly: the page
 * then fetches in the browser as before.
 */
export async function serverApi<T>(path: string): Promise<T | undefined> {
  const base = process.env.API_INTERNAL_URL ?? process.env.API_PROXY_URL;
  if (!base) return undefined;
  const cookie = (await headers()).get('cookie');
  if (!cookie) return undefined;
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { cookie, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}
