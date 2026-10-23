/**
 * Outbound HTTPS to customer-directed integrations. Only the hosts below may receive data, and every one
 * of them is listed in docs/SUBPROCESSORS.md ("Customer-directed integrations") with its purpose and
 * per-region location; a unit test fails if the two drift apart. Calls go through `deps.fetch` so tests
 * replace the providers with mocks, never follow redirects and time out.
 */
export const INTEGRATION_HOSTS: Record<string, string> = {
  'graph.microsoft.com': 'Microsoft 365',
  'login.microsoftonline.com': 'Microsoft 365',
  'admin.googleapis.com': 'Google Workspace',
  'licensing.googleapis.com': 'Google Workspace',
  'oauth2.googleapis.com': 'Google Workspace',
  'api.xero.com': 'Xero Payroll (UK)',
  'identity.xero.com': 'Xero Payroll (UK)',
  'login.xero.com': 'Xero Payroll (UK)',
};

export class IntegrationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationHttpError';
  }
}

export function assertIntegrationUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !(u.hostname in INTEGRATION_HOSTS))
    throw new IntegrationHttpError(0, 'hostNotAllowed', `Outbound host not allowed: ${u.hostname}`);
  return u;
}

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * JSON (or form) request to an allow-listed host. Error bodies are reduced to the provider's error code
 * and a short message so request data (names, emails) is never echoed into logs or the database.
 */
export async function integrationRequest<T = unknown>(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  opts: {
    headers?: Record<string, string>;
    json?: unknown;
    form?: Record<string, string>;
    timeoutMs?: number;
    okStatuses?: number[];
  } = {},
): Promise<JsonResponse<T>> {
  assertIntegrationUrl(url);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetchImpl(url, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
    throw new IntegrationHttpError(
      res.status,
      providerErrorCode(parsed),
      `${method} ${new URL(url).hostname} failed with ${res.status}`,
    );
  }
  return { status: res.status, body: parsed as T };
}

/** Provider error codes only (Graph error.code, Google error.status, OAuth error, Xero problem type). */
export function providerErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object') return 'error';
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === 'string') return err.slice(0, 80);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string') return e.code.slice(0, 80);
    if (typeof e.status === 'string') return e.status.slice(0, 80);
    if (typeof e.code === 'number') return String(e.code);
  }
  if (typeof b.type === 'string') return b.type.slice(0, 80);
  if (typeof b.Type === 'string') return b.Type.slice(0, 80);
  return 'error';
}
