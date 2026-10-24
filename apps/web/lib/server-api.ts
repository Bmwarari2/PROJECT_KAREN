import { headers } from 'next/headers';
import { clientIpHeaders } from './proxy';

/**
 * A GET to the API made by the web server with the viewer's cookie, so a page can render with its
 * first data in the HTML instead of fetching it after hydration (the same path as serverSession).
 * Returns undefined when the API is not configured, refuses, or does not answer quickly: the page
 * then fetches in the browser as before.
 */
export async function serverApi<T>(path: string): Promise<T | undefined> {
  const base = process.env.API_INTERNAL_URL ?? process.env.API_PROXY_URL;
  if (!base) return undefined;
  const h = await headers();
  const cookie = h.get('cookie');
  if (!cookie) return undefined;
  try {
    const res = await fetch(`${base}${path}`, {
      // the API sees the viewer's address, as for proxied calls (CLIENT_IP_SOURCE, ADR-0156)
      headers: { cookie, accept: 'application/json', ...clientIpHeaders(h) },
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Like serverApi, with the status: `{ status }` when the API answered with an error (a 404 is an answer,
 * not a failure), undefined when it is not configured or did not answer quickly.
 */
export async function serverApiResult<T>(path: string): Promise<{ status: number; data?: T } | undefined> {
  const base = process.env.API_INTERNAL_URL ?? process.env.API_PROXY_URL;
  if (!base) return undefined;
  const h = await headers();
  const cookie = h.get('cookie');
  if (!cookie) return undefined;
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { cookie, accept: 'application/json', ...clientIpHeaders(h) },
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? { status: res.status, data: (await res.json()) as T } : { status: res.status };
  } catch {
    return undefined;
  }
}

/**
 * Like serverApi, for a GET the API audits as a view (a document, a payslip): a router prefetch (a link the
 * person only pointed at) fetches nothing, so it is never recorded as a view; the page then fetches in the
 * browser when it is really opened. Only a UUID id is ever put into the path.
 */
export async function serverApiView<T>(collection: string, id: string): Promise<T | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const h = await headers();
  const prefetch =
    h.has('next-router-prefetch') ||
    h.has('next-router-segment-prefetch') ||
    /prefetch/i.test(h.get('sec-purpose') ?? h.get('purpose') ?? '');
  if (prefetch) return undefined;
  return serverApi<T>(`${collection}/${id}`);
}
