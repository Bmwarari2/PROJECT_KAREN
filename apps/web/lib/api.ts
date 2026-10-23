/** Same-origin API client for the browser (the ALB or the dev proxy routes /v1 to the API). */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly body: Record<string, unknown>,
  ) {
    super(title);
  }
}

// Identical GETs in flight at the same time (the shell's badge counts and the home dashboard ask for
// the same lists) share one request; each caller gets its own copy of the result. Nothing is kept once
// the request settles.
const inflight = new Map<string, Promise<unknown>>();

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const plainGet = Object.keys(init).length === 0;
  if (plainGet && typeof window !== 'undefined') {
    let pending = inflight.get(path);
    if (!pending) {
      pending = request<T>(path, init).finally(() => inflight.delete(path));
      inflight.set(path, pending);
    }
    const result = (await pending) as T;
    return result === undefined ? result : structuredClone(result);
  }
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInit & { json?: unknown }): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // 202 Accepted may carry the accepted resource (e.g. a background report run to poll) or nothing
  if (res.status === 202 && !text) return undefined as T;
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiProblem(res.status, body.code ?? 'error', body.title ?? res.statusText, body);
  return body as T;
}

export interface SessionInfo {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  locale: string | null;
  timeZone: string | null;
  employeeId: string | null;
  method: string;
  mfaVerified: boolean;
  hasMfaFactor: boolean;
  hasPassword: boolean;
  isAdmin: boolean;
  roles: string[];
  permissions: string[];
}
