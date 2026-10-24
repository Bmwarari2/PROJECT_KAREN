import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { getPool } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { emitSecurityEvent } from '../../lib/security-events';
import { throttle } from '../auth/common';
import { hashToken, newToken } from '../auth/tokens';
import { staffCookie, STAFF_COOKIE_DEV } from '../../http/security';

/**
 * Thapsus staff authentication for the back office (plan 2.2.1, 2.2.5; ADR-0173):
 *  - sign-in ONLY with a passkey or hardware security key (WebAuthn, user verification required): there
 *    is no staff password and no authenticator-app code any more;
 *  - the first key is registered through a one-time enrolment link that only the operator CLI issues
 *    (`create-staff`, `staff-enrolment-link`), so only someone with database access can bootstrap staff;
 *  - sessions end after 15 idle minutes or 4 hours; destructive actions need a fresh key assertion
 *    (within 5 minutes);
 *  - super-admin actions, rule publishing and support-grant use need a just-in-time elevation (elevations.ts).
 * Staff data lives in the backoffice schema and is reached only with the thapsus_backoffice role. The cookie
 * is `__Host-thr_staff` over HTTPS.
 */
/** Cookie name on plain-HTTP local development and tests; see staffCookie() for HTTPS. */
export const STAFF_COOKIE = STAFF_COOKIE_DEV;
export const STAFF_IDLE_MINUTES = 15;
export const STAFF_ABSOLUTE_HOURS = 4;
/** Destructive actions need a key assertion no older than this (the sign-in itself counts). */
export const STAFF_REAUTH_MINUTES = 5;
/** One-time enrolment links from the operator CLI. */
export const STAFF_ENROLMENT_HOURS = 2;
export type StaffRole = 'super_admin' | 'support' | 'rules_editor' | 'billing';
export type ElevationScope = 'super_admin' | 'rules_publish' | 'support_grant';
export const STAFF_ROLES: StaffRole[] = ['super_admin', 'support', 'rules_editor', 'billing'];

export interface ActiveElevation {
  id: string;
  scope: ElevationScope;
  subjectTenantId: string | null;
  expiresAt: string;
}

export interface StaffAuth {
  staffId: string;
  role: StaffRole;
  email: string;
  sessionId?: string;
  /** When this session last proved the staff member's identity (sign-in or re-authentication). */
  authenticatedAt?: Date;
  elevations?: ActiveElevation[];
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffAuth;
  }
}

export function backofficePool(app: FastifyInstance | { deps: Deps }) {
  if (!app.deps.backofficeDbUrl) throw new ApiError('internal', 'Back office database not configured');
  return getPool(app.deps.backofficeDbUrl);
}

export async function staffAudit(
  app: FastifyInstance,
  req: FastifyRequest,
  action: string,
  detail: Record<string, unknown> = {},
  subjectTenantId?: string | null,
) {
  await backofficePool(app).query(
    `INSERT INTO backoffice.staff_audit (staff_id, action, subject_tenant_id, target, detail, ip, request_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      req.staff?.staffId ?? null,
      action,
      subjectTenantId ?? null,
      req.routeOptions.url,
      JSON.stringify(detail),
      req.ctx.ip,
      req.id,
    ],
  );
}

export interface StaffGuard {
  /** The route needs an active elevation of this scope (an elevated super admin passes too). */
  elevation?: ElevationScope;
  /** A destructive action: the session must have proved the staff member's identity within 5 minutes. */
  reauth?: boolean;
  /** Reachable without any elevation (sign-in state, asking for and approving elevations). */
  noElevation?: boolean;
}

/**
 * preHandler: requires a staff session and one of the roles. A super admin holds no standing access:
 * every route except the sign-in and elevation routes needs an active `super_admin` elevation.
 */
export function requireStaff(app: FastifyInstance, roles: StaffRole[], guard: StaffGuard = {}) {
  const cookie = staffCookie(app.deps.config);
  return async (req: FastifyRequest) => {
    const token = req.cookies?.[cookie.name];
    if (!token) throw new ApiError('unauthorised');
    const now = app.deps.now();
    const pool = backofficePool(app);
    // Sliding idle timeout: the session must have been used within STAFF_IDLE_MINUTES (ASVS V7.3.1).
    const { rows } = await pool.query<{
      id: string;
      staff_id: string;
      role: StaffRole;
      email: string;
      mfa_verified_at: string | null;
      created_at: string;
      reauthenticated_at: string | null;
    }>(
      `UPDATE backoffice.staff_sessions s SET last_seen_at = $2 FROM backoffice.staff_users u
        WHERE u.id = s.staff_id AND s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3 AND u.active
        RETURNING s.id, s.staff_id, u.role, u.email, s.mfa_verified_at, s.created_at, s.reauthenticated_at`,
      [hashToken(token), now, new Date(now.getTime() - STAFF_IDLE_MINUTES * 60_000)],
    );
    const s = rows[0];
    if (!s) throw new ApiError('unauthorised');
    if (!s.mfa_verified_at) throw new ApiError('mfaRequired');
    if (!roles.includes(s.role) && s.role !== 'super_admin') throw new ApiError('forbidden');
    const elevations = (
      await pool.query<{
        id: string;
        scope: ElevationScope;
        subject_tenant_id: string | null;
        expires_at: string;
      }>(
        `SELECT id, scope, subject_tenant_id, expires_at FROM backoffice.staff_elevations
          WHERE staff_id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at > $2`,
        [s.staff_id, now],
      )
    ).rows.map((e) => ({
      id: e.id,
      scope: e.scope,
      subjectTenantId: e.subject_tenant_id,
      expiresAt: new Date(e.expires_at).toISOString(),
    }));
    const authenticatedAt = new Date(
      Math.max(
        new Date(s.created_at).getTime(),
        s.reauthenticated_at ? new Date(s.reauthenticated_at).getTime() : 0,
      ),
    );
    req.staff = {
      staffId: s.staff_id,
      role: s.role,
      email: s.email,
      sessionId: s.id,
      authenticatedAt,
      elevations,
    };
    if (!guard.noElevation) {
      const params = (req.params ?? {}) as { tenantId?: string };
      const has = (scope: ElevationScope) =>
        elevations.some(
          (e) =>
            e.scope === scope &&
            (!e.subjectTenantId || !params.tenantId || e.subjectTenantId === params.tenantId),
        );
      // a super admin's own elevation covers every scope; anyone else needs the route's scope
      const needed: ElevationScope | undefined = s.role === 'super_admin' ? 'super_admin' : guard.elevation;
      if (needed && !has(needed)) {
        emitSecurityEvent(app.deps, req, {
          type: 'staff.elevation_missing',
          severity: 'low',
          staffId: s.staff_id,
          detail: { scope: needed },
        });
        throw new ApiError('forbidden', 'elevationRequired', { reason: 'elevationRequired', scope: needed });
      }
    }
    if (guard.reauth && now.getTime() - authenticatedAt.getTime() > STAFF_REAUTH_MINUTES * 60_000)
      throw new ApiError('reauthenticationRequired', undefined, { windowMinutes: STAFF_REAUTH_MINUTES });
  };
}

/**
 * For routes that publish only sometimes (a law-change entry saved as a draft needs nothing): refuses
 * unless the signed-in staff member holds an active elevation of the scope. Super admins reached the
 * handler only with their own `super_admin` elevation, which covers every scope.
 */
export function assertElevated(
  deps: Pick<Deps, 'config' | 'now'>,
  req: FastifyRequest,
  scope: ElevationScope,
) {
  const staff = req.staff;
  if (!staff) throw new ApiError('unauthorised');
  if (staff.elevations?.some((e) => e.scope === scope || e.scope === 'super_admin')) return;
  emitSecurityEvent(deps, req, {
    type: 'staff.elevation_missing',
    severity: 'low',
    staffId: staff.staffId,
    detail: { scope },
  });
  throw new ApiError('forbidden', 'elevationRequired', { reason: 'elevationRequired', scope });
}

const uuidToBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** The relying party for staff keys: the back office's own address (the app's until it has one). */
export function staffRelyingParty(deps: Pick<Deps, 'config'>) {
  const origin = deps.config.backofficeBaseUrl ?? deps.config.appBaseUrl;
  return { rpID: new URL(origin).hostname, origin, rpName: 'Thapsus-HR back office' };
}

/**
 * Issues a one-time enrolment link for a staff member (operator CLI only; it needs database access).
 * With resetKeys, the staff member's registered keys are removed and their sessions end first (a lost key).
 */
export async function issueStaffEnrolment(
  app: { deps: Deps },
  staffId: string,
  opts: { resetKeys?: boolean } = {},
): Promise<{ token: string; url: string; expiresAt: Date }> {
  const pool = backofficePool(app);
  if (opts.resetKeys) {
    await pool.query('DELETE FROM backoffice.staff_passkeys WHERE staff_id = $1', [staffId]);
    await pool.query(
      'UPDATE backoffice.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL',
      [staffId],
    );
  }
  // only the newest link works
  await pool.query(
    'UPDATE backoffice.staff_enrolments SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL',
    [staffId],
  );
  const token = newToken();
  const expiresAt = new Date(app.deps.now().getTime() + STAFF_ENROLMENT_HOURS * 3_600_000);
  await pool.query(
    'INSERT INTO backoffice.staff_enrolments (staff_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [staffId, hashToken(token), expiresAt],
  );
  await pool.query(
    `INSERT INTO backoffice.staff_audit (staff_id, action, detail) VALUES ($1, 'staff.enrolment_issued', $2)`,
    [staffId, JSON.stringify({ resetKeys: !!opts.resetKeys, validHours: STAFF_ENROLMENT_HOURS })],
  );
  const { origin } = staffRelyingParty(app.deps);
  // the token travels in the fragment, so it never reaches a server log or a Referer header
  return { token, url: `${origin}/backoffice/enrol#token=${token}`, expiresAt };
}

/** Creates a staff account with no credential yet and returns its one-time enrolment link. */
export async function createStaff(
  app: FastifyInstance | { deps: Deps },
  email: string,
  displayName: string,
  role: StaffRole,
) {
  const id = crypto.randomUUID();
  await backofficePool(app).query(
    `INSERT INTO backoffice.staff_users (id, email, display_name, role) VALUES ($1, $2, $3, $4)`,
    [id, email, displayName, role],
  );
  const enrolment = await issueStaffEnrolment(app, id);
  return {
    id,
    enrolmentToken: enrolment.token,
    enrolmentUrl: enrolment.url,
    expiresAt: enrolment.expiresAt,
  };
}

type AssertionJson = Parameters<typeof verifyAuthenticationResponse>[0]['response'];
type RegistrationJson = Parameters<typeof verifyRegistrationResponse>[0]['response'];

export async function backofficeAuthRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const cookie = staffCookie(deps.config);
  const rp = staffRelyingParty(deps);
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookie.name, token, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
      path: cookie.path,
    });
  const pool = () => backofficePool(app);

  async function newChallenge(kind: 'login' | 'reauth' | 'enrol', challenge: string, staffId?: string) {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO backoffice.staff_challenges (staff_id, kind, challenge, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [staffId ?? null, kind, challenge, new Date(deps.now().getTime() + 5 * 60_000)],
    );
    return rows[0]!.id;
  }
  /** Consumes a challenge once (its own statement, so a failed verification cannot roll it back). */
  async function consume(id: string, kind: string, staffId?: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await pool().query<{ challenge: string; staff_id: string | null }>(
      `UPDATE backoffice.staff_challenges SET used_at = now()
        WHERE id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3 AND ($4::uuid IS NULL OR staff_id = $4::uuid)
        RETURNING challenge, staff_id`,
      [id, kind, deps.now(), staffId ?? null],
    );
    return rows[0];
  }

  async function startStaffSession(reply: FastifyReply, staffId: string) {
    const token = newToken();
    const now = deps.now();
    await pool().query(
      `INSERT INTO backoffice.staff_sessions (staff_id, token_hash, expires_at, created_at, last_seen_at, mfa_verified_at, reauthenticated_at)
       VALUES ($1, $2, $3, $4, $4, $4, $4)`,
      [staffId, hashToken(token), new Date(now.getTime() + STAFF_ABSOLUTE_HOURS * 3_600_000), now],
    );
    setCookie(reply, token);
  }

  /** Verifies an assertion against one of the staff member's keys; returns the staff id or undefined. */
  async function verifyAssertion(
    challenge: string,
    response: AssertionJson,
    expectStaff?: string,
  ): Promise<string | undefined> {
    const { rows } = await pool().query<{
      id: string;
      staff_id: string;
      credential_id: string;
      public_key: Buffer;
      counter: string;
      transports: string[];
      active: boolean;
    }>(
      `SELECT k.id, k.staff_id, k.credential_id, k.public_key, k.counter, k.transports, u.active
         FROM backoffice.staff_passkeys k JOIN backoffice.staff_users u ON u.id = k.staff_id WHERE k.credential_id = $1`,
      [typeof response?.id === 'string' ? response.id : ''],
    );
    const key = rows[0];
    if (!key || !key.active || (expectStaff && key.staff_id !== expectStaff)) return undefined;
    if (response.response?.userHandle) {
      const handle = bytesToUuid(Buffer.from(response.response.userHandle, 'base64url'));
      if (handle !== key.staff_id) return undefined;
    }
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: key.credential_id,
        publicKey: new Uint8Array(key.public_key),
        counter: Number(key.counter),
        transports: key.transports as never,
      },
    }).catch(() => undefined);
    if (!result?.verified) return undefined;
    await pool().query(
      'UPDATE backoffice.staff_passkeys SET counter = $2, last_used_at = now() WHERE id = $1',
      [key.id, result.authenticationInfo.newCounter],
    );
    return key.staff_id;
  }

  const Assertion = Type.Object({ challengeId: Type.String({ maxLength: 40 }), response: Type.Any() });

  app.post(
    '/v1/backoffice/auth/passkey/options',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        summary: 'Begin a staff sign-in with a passkey or security key',
        response: { 200: Type.Object({ challengeId: Type.String(), options: Type.Any() }), 429: Problem },
      },
    },
    async (req) => {
      await throttle(deps, [[`staff:ip:${req.ctx.ip}`, 30, 900]], req);
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
      return { challengeId: await newChallenge('login', options.challenge), options };
    },
  );

  app.post(
    '/v1/backoffice/auth/passkey/verify',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        summary: 'Finish a staff sign-in (user verification required); starts a 4-hour session',
        body: Assertion,
        response: { 204: Type.Null(), 401: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { challengeId: string; response: AssertionJson };
      await throttle(deps, [[`staff-verify:ip:${req.ctx.ip}`, 30, 900]], req);
      const ch = await consume(b.challengeId, 'login');
      const staffId = ch ? await verifyAssertion(ch.challenge, b.response) : undefined;
      if (!staffId) {
        await staffAudit(app, req, 'staff.login_failed', { reason: ch ? 'invalid' : 'challenge' });
        emitSecurityEvent(deps, req, {
          type: 'staff.login_failed',
          severity: 'medium',
          detail: { factor: 'webauthn' },
        });
        throw new ApiError('invalidCredentials');
      }
      await throttle(deps, [[`staff:acct:${staffId}`, 20, 900]], req);
      await startStaffSession(reply, staffId);
      req.staff = { staffId, role: 'support', email: '' };
      await staffAudit(app, req, 'staff.login', { factor: 'webauthn' });
      emitSecurityEvent(deps, req, { type: 'staff.login', severity: 'info', staffId });
      return reply.status(204).send(null);
    },
  );

  // ---- re-authentication before destructive actions ------------------------------------------------------
  app.post(
    '/v1/backoffice/auth/reauth/options',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        summary: 'Begin a re-authentication with your key (destructive actions need one within 5 minutes)',
        response: { 200: Type.Object({ challengeId: Type.String(), options: Type.Any() }), 401: Problem },
      },
    },
    async (req) => {
      const { rows } = await pool().query<{ credential_id: string; transports: string[] }>(
        'SELECT credential_id, transports FROM backoffice.staff_passkeys WHERE staff_id = $1',
        [req.staff!.staffId],
      );
      const options = await generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: 'required',
        allowCredentials: rows.map((r) => ({ id: r.credential_id, transports: r.transports as never })),
      });
      return { challengeId: await newChallenge('reauth', options.challenge, req.staff!.staffId), options };
    },
  );

  app.post(
    '/v1/backoffice/auth/reauth/verify',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        body: Assertion,
        response: { 204: Type.Null(), 401: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { challengeId: string; response: AssertionJson };
      const staffId = req.staff!.staffId;
      await throttle(deps, [[`staff-reauth:${staffId}`, 10, 900]], req);
      const ch = await consume(b.challengeId, 'reauth', staffId);
      const ok = ch ? await verifyAssertion(ch.challenge, b.response, staffId) : undefined;
      if (!ok) {
        await staffAudit(app, req, 'staff.reauth_failed');
        emitSecurityEvent(deps, req, { type: 'staff.reauth_failed', severity: 'medium', staffId });
        throw new ApiError('invalidCredentials');
      }
      await pool().query('UPDATE backoffice.staff_sessions SET reauthenticated_at = $2 WHERE id = $1', [
        req.staff!.sessionId,
        deps.now(),
      ]);
      await staffAudit(app, req, 'staff.reauthenticated');
      return reply.status(204).send(null);
    },
  );

  // ---- one-time enrolment (link from the operator CLI) --------------------------------------------------
  async function enrolment(token: string) {
    const { rows } = await pool().query<{
      id: string;
      staff_id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT e.id, e.staff_id, u.email, u.display_name FROM backoffice.staff_enrolments e JOIN backoffice.staff_users u ON u.id = e.staff_id
        WHERE e.token_hash = $1 AND e.used_at IS NULL AND e.expires_at > $2 AND u.active`,
      [hashToken(token), deps.now()],
    );
    return rows[0];
  }
  const EnrolToken = Type.String({ minLength: 20, maxLength: 100 });

  app.post(
    '/v1/backoffice/auth/enrol/options',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        summary: 'Begin registering a staff passkey or security key with a one-time enrolment link',
        body: Type.Object({ token: EnrolToken }, { additionalProperties: false }),
        response: {
          200: Type.Object({ challengeId: Type.String(), options: Type.Any(), email: Type.String() }),
          401: Problem,
          429: Problem,
        },
      },
    },
    async (req) => {
      await throttle(deps, [[`staff-enrol:ip:${req.ctx.ip}`, 20, 900]], req);
      const e = await enrolment((req.body as { token: string }).token);
      if (!e) throw new ApiError('invalidCredentials', 'enrolmentLinkInvalid');
      const { rows } = await pool().query<{ credential_id: string; transports: string[] }>(
        'SELECT credential_id, transports FROM backoffice.staff_passkeys WHERE staff_id = $1',
        [e.staff_id],
      );
      const options = await generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userName: e.email,
        userDisplayName: e.display_name,
        userID: uuidToBytes(e.staff_id),
        attestationType: 'none',
        excludeCredentials: rows.map((r) => ({ id: r.credential_id, transports: r.transports as never })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      return {
        challengeId: await newChallenge('enrol', options.challenge, e.staff_id),
        options,
        email: e.email,
      };
    },
  );

  app.post(
    '/v1/backoffice/auth/enrol/verify',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        summary: 'Finish registering the key; the link is used up and a staff session starts',
        body: Type.Object(
          {
            token: EnrolToken,
            challengeId: Type.String({ maxLength: 40 }),
            response: Type.Any(),
            name: Type.Optional(Type.String({ maxLength: 80 })),
          },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null(), 401: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { token: string; challengeId: string; response: RegistrationJson; name?: string };
      await throttle(deps, [[`staff-enrol:ip:${req.ctx.ip}`, 20, 900]], req);
      // the link is used up first (atomically), so it can never register two keys
      const { rows } = await pool().query<{ staff_id: string }>(
        `UPDATE backoffice.staff_enrolments e SET used_at = now() FROM backoffice.staff_users u
          WHERE u.id = e.staff_id AND e.token_hash = $1 AND e.used_at IS NULL AND e.expires_at > $2 AND u.active
          RETURNING e.staff_id`,
        [hashToken(b.token), deps.now()],
      );
      const staffId = rows[0]?.staff_id;
      const ch = staffId ? await consume(b.challengeId, 'enrol', staffId) : undefined;
      const result =
        staffId && ch
          ? await verifyRegistrationResponse({
              response: b.response,
              expectedChallenge: ch.challenge,
              expectedOrigin: rp.origin,
              expectedRPID: rp.rpID,
              requireUserVerification: true,
            }).catch(() => undefined)
          : undefined;
      if (!staffId || !result?.verified || !result.registrationInfo) {
        req.staff = staffId ? { staffId, role: 'support', email: '' } : undefined;
        await staffAudit(app, req, 'staff.enrolment_failed');
        emitSecurityEvent(deps, req, {
          type: 'staff.login_failed',
          severity: 'medium',
          staffId,
          detail: { step: 'enrolment' },
        });
        throw new ApiError('invalidCredentials', 'enrolmentLinkInvalid');
      }
      const cred = result.registrationInfo.credential;
      await pool().query(
        `INSERT INTO backoffice.staff_passkeys (staff_id, credential_id, public_key, counter, transports, name) VALUES ($1, $2, $3, $4, $5, $6)`,
        [staffId, cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? [], b.name ?? null],
      );
      await startStaffSession(reply, staffId);
      req.staff = { staffId, role: 'support', email: '' };
      await staffAudit(app, req, 'staff.enrolled', { transports: cred.transports ?? [] });
      emitSecurityEvent(deps, req, { type: 'staff.enrolled', severity: 'medium', staffId });
      return reply.status(204).send(null);
    },
  );

  // Who is signed in (the back-office UI uses this), with the elevations in force.
  app.get(
    '/v1/backoffice/auth/session',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({
            staffId: Type.String(),
            email: Type.String(),
            displayName: Type.String(),
            role: Type.String(),
            cell: Type.String(),
            elevations: Type.Array(
              Type.Object({
                id: Type.String(),
                scope: Type.String(),
                subjectTenantId: Type.Union([Type.String(), Type.Null()]),
                expiresAt: Type.String(),
              }),
            ),
            reauthenticatedAt: Type.String(),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async (req) => {
      const { rows } = await pool().query<{ display_name: string }>(
        'SELECT display_name FROM backoffice.staff_users WHERE id = $1',
        [req.staff!.staffId],
      );
      return {
        staffId: req.staff!.staffId,
        email: req.staff!.email,
        displayName: rows[0]?.display_name ?? '',
        role: req.staff!.role,
        cell: deps.config.cell,
        elevations: req.staff!.elevations ?? [],
        reauthenticatedAt: (req.staff!.authenticatedAt ?? deps.now()).toISOString(),
      };
    },
  );

  app.post(
    '/v1/backoffice/auth/logout',
    {
      config: { auth: 'public', selfAudited: true },
      schema: { tags: ['backoffice'], response: { 204: Type.Null() } },
    },
    async (req, reply) => {
      const token = req.cookies?.[cookie.name];
      if (token) {
        const { rows } = await pool().query<{ staff_id: string }>(
          'UPDATE backoffice.staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING staff_id',
          [hashToken(token)],
        );
        if (rows[0]) {
          req.staff = { staffId: rows[0].staff_id, role: 'support', email: '' };
          await staffAudit(app, req, 'staff.logout');
        }
      }
      reply.clearCookie(cookie.name, {
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: true,
        sameSite: 'strict',
      });
      reply.header('Clear-Site-Data', '"cache"');
      return reply.status(204).send(null);
    },
  );
}
