import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema';

export type { paths, components } from './generated/schema';
export { verifyWebhookSignature, type VerifyOptions } from './webhooks';

export interface ThapsusClientOptions {
  /** Regional API base URL, e.g. https://api.uk.<domain> — always your workspace's home region. */
  baseUrl: string;
  /** Scoped API key (thr_sk_…) or OAuth 2.0 access token (thr_at_…). */
  token?: string;
  /** Optional idempotency key generator for POST and PATCH requests (sent as Idempotency-Key). */
  idempotencyKey?: () => string;
  fetch?: typeof fetch;
}

/** Typed client for the Thapsus-HR public REST API (/v1). */
export function createThapsusClient(opts: ThapsusClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const auth: Middleware = {
    onRequest({ request }) {
      if (opts.token) request.headers.set('Authorization', `Bearer ${opts.token}`);
      if (
        opts.idempotencyKey &&
        (request.method === 'POST' || request.method === 'PATCH') &&
        !request.headers.has('Idempotency-Key')
      ) {
        request.headers.set('Idempotency-Key', opts.idempotencyKey());
      }
      return request;
    },
  };
  client.use(auth);
  return client;
}

export interface AccessToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

/** OAuth 2.0 client credentials grant (RFC 6749 §4.4) against POST /v1/oauth/token. */
export async function getClientCredentialsToken(o: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string[];
  fetch?: typeof fetch;
}): Promise<AccessToken> {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (o.scope?.length) body.set('scope', o.scope.join(' '));
  const basic = Buffer.from(
    `${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`,
  ).toString('base64');
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  const json = (await res.json()) as AccessToken & { error?: string };
  if (!res.ok) throw new Error(`token request failed: ${json.error ?? res.status}`);
  return json;
}

/** Iterates every item of a cursor-paginated list endpoint ({ data, nextCursor }). */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ data?: { data: T[]; nextCursor: string | null } }>,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const { data } = await fetchPage(cursor);
    if (!data) return;
    yield* data.data;
    cursor = data.nextCursor ?? undefined;
  } while (cursor);
}
