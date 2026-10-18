import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema';

export type { paths } from './generated/schema';

export interface ThapsusClientOptions {
  /** Regional API base URL, e.g. https://api.uk.<domain> — always your workspace's home region. */
  baseUrl: string;
  /** Scoped API key or OAuth 2.0 access token. */
  token?: string;
  /** Optional idempotency key generator for POST/PATCH/PUT/DELETE requests. */
  idempotencyKey?: () => string;
  fetch?: typeof fetch;
}

/** Typed client for the Thapsus-HR public REST API (/v1). */
export function createThapsusClient(opts: ThapsusClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const auth: Middleware = {
    onRequest({ request }) {
      if (opts.token) request.headers.set('Authorization', `Bearer ${opts.token}`);
      if (opts.idempotencyKey && request.method !== 'GET') request.headers.set('Idempotency-Key', opts.idempotencyKey());
      return request;
    },
  };
  client.use(auth);
  return client;
}
