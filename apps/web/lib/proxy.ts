import { isIP } from 'node:net';

/**
 * Runtime reverse proxy to the API (API_PROXY_URL) for local development and e2e, and on Google Cloud staging, where
 * the API runs as a sidecar of this container in one Cloud Run service (ADR-0156). In AWS the ALB routes these paths
 * to the API service directly and this handler is never reached.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
/** Client-supplied forwarding headers are dropped: the API trusts exactly one proxy hop (this one). */
const SPOOFABLE = new Set(['x-forwarded-for', 'x-real-ip', 'forwarded']);

/**
 * The client address to pass on to the API, or undefined to pass none (the default: the API then sees this proxy).
 * CLIENT_IP_SOURCE=cloud-run: Cloud Run's front end appends the address of the peer it accepted the connection from
 * to X-Forwarded-For, so only the RIGHTMOST entry is trustworthy; everything to its left was sent by the client.
 * That entry is used only if it is an IP address.
 */
export function forwardedClientIp(
  incoming: Headers,
  source: string | undefined = process.env.CLIENT_IP_SOURCE,
): string | undefined {
  if (!source) return undefined;
  if (source !== 'cloud-run') throw new Error('CLIENT_IP_SOURCE must be cloud-run or unset');
  const last = incoming.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return last && isIP(last) ? last : undefined;
}

/** The forwarding header to send to the API for the client of this request (see forwardedClientIp). */
export function clientIpHeaders(
  incoming: Headers,
  source: string | undefined = process.env.CLIENT_IP_SOURCE,
): Record<string, string> {
  const ip = forwardedClientIp(incoming, source);
  return ip ? { 'x-forwarded-for': ip } : {};
}

export async function proxyToApi(req: Request): Promise<Response> {
  const target = process.env.API_PROXY_URL;
  if (!target) return new Response(null, { status: 404 });
  const url = new URL(req.url);
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k) && !SPOOFABLE.has(k)) headers.set(k, v);
  });
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  for (const [k, v] of Object.entries(clientIpHeaders(req.headers))) headers.set(k, v);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const res = await fetch(`${target}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k) && k !== 'set-cookie' && k !== 'content-encoding') out.set(k, v);
  });
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(res.status === 204 || res.status === 304 ? null : await res.arrayBuffer(), {
    status: res.status,
    headers: out,
  });
}
