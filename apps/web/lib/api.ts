import type { CapabilityKey } from '@thapsus/core/capabilities';

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

/**
 * Request options. A state-changing call names the capability of the UI action behind it (the
 * permission map, ADR-0188): the contract test checks it against the capability of the route it calls,
 * and the control is shown only to people who hold it. It is not sent.
 */
export type ApiInit = RequestInit & { json?: unknown; capability?: CapabilityKey };

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
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

/**
 * The raw response, for calls that read the status or upload a form (multipart): same-origin
 * credentials, with the capability left out of the request like `api()`.
 */
export function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const { json, capability: _capability, ...rest } = init;
  return fetch(path, {
    credentials: 'same-origin',
    ...rest,
    ...(json !== undefined
      ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...rest.headers } }
      : {}),
  });
}

async function request<T>(path: string, init: ApiInit): Promise<T> {
  const { json, headers, capability: _capability, ...rest } = init;
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
  /** A new password can be set without the current one (emailed-link sign-in, within 10 minutes). */
  passwordWithoutCurrent?: boolean;
  isAdmin: boolean;
  /** Must set up and use a second factor (admins; everyone when the workspace requires it). */
  mustUseMfa?: boolean;
  roles: string[];
  permissions: string[];
}
