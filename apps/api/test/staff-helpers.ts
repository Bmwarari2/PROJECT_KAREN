import type { TestContext } from './helpers';
import { randomIp } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';
import {
  createStaff,
  staffRelyingParty,
  type ElevationScope,
  type StaffRole,
} from '../src/modules/backoffice/auth';
import { ELEVATION_ROLES } from '../src/modules/backoffice/elevations';

/**
 * Thapsus staff in API tests (ADR-0174): accounts come from the operator path (createStaff, as the CLI does),
 * the one-time enrolment link registers a software passkey (user verification on), and sign-in is a WebAuthn
 * assertion. Elevations are requested and then approved by a second, freshly enrolled staff member.
 */
export interface StaffSession {
  cookie: string;
  staffId: string;
  email: string;
  role: StaffRole;
  key: SoftAuthenticator;
}

export function staffCookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.map((x) => String(x).split(';')[0]!).find((x) => /^(__Host-)?thr_staff=/.test(x));
  if (!c) throw new Error('no staff cookie');
  return c;
}

const post = (ctx: TestContext, url: string, payload: unknown, cookie?: string, ip = randomIp()) =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: cookie ? { cookie } : {},
    remoteAddress: ip,
  });

/** Creates a staff account and registers a key with its enrolment link; returns the signed-in session. */
export async function enrolStaff(ctx: TestContext, role: StaffRole): Promise<StaffSession> {
  const email = `${role}.${Math.random().toString(36).slice(2, 8)}@thapsus.example.test`;
  const s = await createStaff(ctx.app, email, 'Fictional Staff Member', role);
  const rp = staffRelyingParty(ctx.deps);
  const key = new SoftAuthenticator(rp.rpID, rp.origin);
  const ip = randomIp();
  const options = await post(
    ctx,
    '/v1/backoffice/auth/enrol/options',
    { token: s.enrolmentToken },
    undefined,
    ip,
  );
  if (options.statusCode !== 200) throw new Error(`enrol options ${options.statusCode} ${options.body}`);
  const { challengeId, options: o } = options.json();
  const verify = await post(
    ctx,
    '/v1/backoffice/auth/enrol/verify',
    { token: s.enrolmentToken, challengeId, response: key.register(o) },
    undefined,
    ip,
  );
  if (verify.statusCode !== 204) throw new Error(`enrol verify ${verify.statusCode} ${verify.body}`);
  return { cookie: staffCookieFrom(verify), staffId: s.id, email, role, key };
}

/** A fresh sign-in with the staff member's key. */
export async function staffSignIn(ctx: TestContext, key: SoftAuthenticator): Promise<string> {
  const ip = randomIp();
  const options = await post(ctx, '/v1/backoffice/auth/passkey/options', {}, undefined, ip);
  const { challengeId, options: o } = options.json();
  const verify = await post(
    ctx,
    '/v1/backoffice/auth/passkey/verify',
    { challengeId, response: key.assert(o) },
    undefined,
    ip,
  );
  if (verify.statusCode !== 204) throw new Error(`staff sign-in ${verify.statusCode} ${verify.body}`);
  return staffCookieFrom(verify);
}

/** Re-authenticates a staff session with its key (destructive actions need one within 5 minutes). */
export async function staffReauth(ctx: TestContext, s: StaffSession) {
  const options = await post(ctx, '/v1/backoffice/auth/reauth/options', {}, s.cookie);
  const { challengeId, options: o } = options.json();
  const r = await post(
    ctx,
    '/v1/backoffice/auth/reauth/verify',
    { challengeId, response: s.key.assert(o) },
    s.cookie,
  );
  if (r.statusCode !== 204) throw new Error(`staff reauth ${r.statusCode} ${r.body}`);
}

/** Requests an elevation for the staff member and has a second staff member approve it. */
export async function elevate(
  ctx: TestContext,
  s: StaffSession,
  scope: ElevationScope,
  opts: { minutes?: number; tenantId?: string; approver?: StaffSession } = {},
) {
  const req = await post(
    ctx,
    '/v1/backoffice/elevations',
    {
      scope,
      reason: 'Fictional ticket 4242: investigating a reported problem',
      minutes: opts.minutes ?? 60,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    s.cookie,
  );
  if (req.statusCode !== 201) throw new Error(`elevation request ${req.statusCode} ${req.body}`);
  const approver = opts.approver ?? (await enrolStaff(ctx, ELEVATION_ROLES[scope][0]!));
  const ok = await post(ctx, `/v1/backoffice/elevations/${req.json().id}/approve`, {}, approver.cookie);
  if (ok.statusCode !== 200) throw new Error(`elevation approve ${ok.statusCode} ${ok.body}`);
  return req.json().id as string;
}

/**
 * A signed-in staff member. Super admins get a super_admin elevation by default (they hold no standing
 * access); pass `elevate` for other scopes, or `elevate: []` for none.
 */
export async function staffSession(
  ctx: TestContext,
  role: StaffRole,
  opts: { elevate?: ElevationScope[] } = {},
): Promise<StaffSession> {
  const s = await enrolStaff(ctx, role);
  for (const scope of opts.elevate ?? (role === 'super_admin' ? ['super_admin'] : []))
    await elevate(ctx, s, scope);
  return s;
}
