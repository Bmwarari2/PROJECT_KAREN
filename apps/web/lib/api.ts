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

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
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
