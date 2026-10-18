/**
 * Runtime reverse proxy to the API for local development and e2e (API_PROXY_URL). In AWS the ALB
 * routes these paths to the API service directly and this handler is never reached.
 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
/** Client-supplied forwarding headers are dropped: the API trusts exactly one proxy hop (this one). */
const SPOOFABLE = new Set(['x-forwarded-for', 'x-real-ip', 'forwarded']);

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
  return new Response(res.status === 204 || res.status === 304 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
}
