import { actionMatches } from './permissions';

/**
 * Public API scopes (OAuth 2.0 client credentials and API keys). A machine client's effective
 * permissions are the INTERSECTION of the permissions its scopes allow with the permissions of the
 * role the admin attached to it — a scope never grants more than the role, and the role never
 * grants more than the scopes. Scopes never include identity, security or settings management.
 */
export const API_SCOPES = {
  'employees:read': ['employees.read', 'employees.history'],
  'employees:write': [
    'employees.read',
    'employees.history',
    'employees.create',
    'employees.update',
    'employees.terminate',
  ],
  'org:read': ['org.read', 'employees.read'],
  'org:write': ['org.read', 'org.manage', 'org.reporting'],
  'leave:read': ['leave.read', 'absence.read'],
  'leave:write': [
    'leave.read',
    'absence.read',
    'leave.record',
    'leave.manage',
    'leave.adjust',
    'absence.record',
  ],
  'time:read': ['time.read', 'rota.view', 'time.export'],
  'time:write': ['time.read', 'rota.view', 'rota.manage', 'time.manage', 'time.correct', 'time.approve'],
  'documents:read': ['documents.read'],
  'documents:write': ['documents.read', 'documents.manage'],
  'audit:read': ['audit.read', 'audit.export'],
  'webhooks:manage': ['webhooks.manage'],
} as const satisfies Record<string, readonly string[]>;

export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_KEYS = Object.keys(API_SCOPES) as ApiScope[];

/**
 * Path prefixes an API client may call at all (deny by default). Everything else — sign-in, MFA,
 * the caller's own profile, settings, back office — is reserved for people.
 */
export const API_CLIENT_PATH_PREFIXES = [
  '/v1/employees',
  '/v1/directory',
  '/v1/org',
  '/v1/org-chart',
  '/v1/leave',
  '/v1/sickness',
  '/v1/absence',
  '/v1/fmla',
  '/v1/shifts',
  '/v1/rota',
  '/v1/clock/events',
  '/v1/timesheets',
  '/v1/documents',
  '/v1/audit/events',
  '/v1/webhooks',
  '/v1/jobs',
  '/v1/holidays',
  '/v1/rules',
] as const;

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === 'string' && v in API_SCOPES;
}

export function apiClientMayCall(path: string): boolean {
  return API_CLIENT_PATH_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
  );
}

/**
 * Intersection of two permission patterns (exact actions or prefix wildcards such as "employees.*",
 * "vault.read:*" and "*"): the more specific pattern when one covers the other, otherwise nothing.
 */
export function intersectPattern(a: string, b: string): string | undefined {
  if (actionMatches(a, b)) return b;
  if (actionMatches(b, a)) return a;
  // "a.*" ∩ "a.b:*" style overlaps are covered above; disjoint prefixes have no intersection.
  return undefined;
}

/** Effective permissions of a machine client: role permissions ∩ permissions of the granted scopes. */
export function scopedPermissions(rolePermissions: readonly string[], scopes: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const s of scopes) if (isApiScope(s)) for (const p of API_SCOPES[s]) allowed.add(p);
  const out = new Set<string>();
  for (const r of rolePermissions) {
    for (const p of allowed) {
      const i = intersectPattern(r, p);
      if (i) out.add(i);
    }
  }
  return [...out].sort();
}
