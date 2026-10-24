import { withTenant } from '@thapsus/db';
import type { Deps } from '../../deps';

/**
 * Credential-stuffing defence (plan 2.1.6, ADR-0172): per-account and per-tenant budgets next to the
 * per-IP limits, because attackers spread attempts over thousands of residential addresses. All windows
 * are 15 minutes. The per-tenant budgets grow with the workspace so a large employer's Monday morning
 * never trips them: the larger of a floor and a share of the workspace's active people.
 */
export const AUTH_WINDOW_SECONDS = 900;

export const TENANT_BUDGETS = {
  /** Failed password sign-ins across the workspace. */
  loginFailures: { floor: 100, perUser: 0.05 },
  /** Failed authenticator codes across the workspace. */
  mfaFailures: { floor: 50, perUser: 0.02 },
  /** Emailed sign-in and password-reset links requested for the workspace. */
  emailLinks: { floor: 100, perUser: 0.02 },
} as const;
export type TenantBudget = keyof typeof TENANT_BUDGETS;

/** Per account (workspace + email, or user) and per IP, per 15 minutes. */
export const ACCOUNT_LIMITS = {
  loginAttempts: 10,
  loginAttemptsPerIp: 50,
  magicLinkRequests: 3,
  magicLinkRequestsPerIp: 20,
  resetRequests: 3,
  resetRequestsPerIp: 20,
  resetCompletionsPerIp: 30,
  mfaAttempts: 5,
  mfaAttemptsPerIp: 30,
} as const;

const sizes = new Map<string, { n: number; at: number }>();
const SIZE_TTL_MS = 10 * 60_000;

async function activePeople(deps: Deps, tenantId: string): Promise<number> {
  const hit = sizes.get(tenantId);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.n;
  const n = await withTenant(
    deps.router,
    tenantId,
    async (tx) =>
      (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.users WHERE status = 'active'`)).n,
    { readOnly: true },
  ).catch(() => 0);
  sizes.set(tenantId, { n, at: Date.now() });
  return n;
}

/** The tenant's budget for one kind of attempt in the 15-minute window. */
export async function tenantBudget(deps: Deps, tenantId: string, kind: TenantBudget): Promise<number> {
  const b = { ...TENANT_BUDGETS[kind], ...deps.authBudgets?.[kind] };
  return Math.max(b.floor, Math.ceil((await activePeople(deps, tenantId)) * b.perUser));
}

export const tenantKey = (name: string, tenantId: string) => `${name}:tenant:${tenantId}`;
