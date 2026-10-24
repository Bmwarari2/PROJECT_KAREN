import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import * as OTPAuth from 'otpauth';
import { getPool } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { open, seal, type Envelope } from '../../lib/kms';
import { throttle } from '../auth/common';
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from '../auth/tokens';
import { staffCookie, STAFF_COOKIE_DEV } from '../../http/security';

/**
 * Thapsus staff authentication for the back office: password + mandatory TOTP (each code once),
 * sessions that end after 30 idle minutes or 8 hours. Staff data lives in the backoffice schema and
 * is reached only with the thapsus_backoffice role. The cookie is `__Host-thr_staff` over HTTPS.
 */
/** Cookie name on plain-HTTP local development and tests; see staffCookie() for HTTPS. */
export const STAFF_COOKIE = STAFF_COOKIE_DEV;
export const STAFF_IDLE_MINUTES = 30;
export const STAFF_ABSOLUTE_HOURS = 8;
export type StaffRole = 'super_admin' | 'support' | 'rules_editor' | 'billing' | 'security_analyst';

export interface StaffAuth {
  staffId: string;
  role: StaffRole;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffAuth;
  }
}

export function backofficePool(app: FastifyInstance) {
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

/**
 * Extra checks a route can ask for. The just-in-time elevation work (Agent C, ADR-0173) enforces them; until
 * it is merged they are accepted and ignored here, so routes can already declare what they need:
 * `noElevation` for read-only aggregate screens every staff member may open, `reauth` for destructive actions.
 */
export interface StaffGuard {
  reauth?: boolean;
  noElevation?: boolean;
}

/** preHandler: requires a staff session with MFA and one of the roles. */
export function requireStaff(app: FastifyInstance, roles: StaffRole[], _guard: StaffGuard = {}) {
  const cookie = staffCookie(app.deps.config);
  return async (req: FastifyRequest) => {
    const token = req.cookies?.[cookie.name];
    if (!token) throw new ApiError('unauthorised');
    const now = app.deps.now();
    // Sliding idle timeout: the session must have been used within STAFF_IDLE_MINUTES (ASVS V7.3.1).
    const { rows } = await backofficePool(app).query<{
      staff_id: string;
      role: StaffRole;
      email: string;
      mfa_verified_at: string | null;
    }>(
      `UPDATE backoffice.staff_sessions s SET last_seen_at = $2 FROM backoffice.staff_users u
        WHERE u.id = s.staff_id AND s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3 AND u.active
        RETURNING s.staff_id, u.role, u.email, s.mfa_verified_at`,
      [hashToken(token), now, new Date(now.getTime() - STAFF_IDLE_MINUTES * 60_000)],
    );
    const s = rows[0];
    if (!s) throw new ApiError('unauthorised');
    if (!s.mfa_verified_at) throw new ApiError('mfaRequired');
    if (!roles.includes(s.role) && s.role !== 'super_admin') throw new ApiError('forbidden');
    req.staff = { staffId: s.staff_id, role: s.role, email: s.email };
  };
}

export async function createStaff(
  app: FastifyInstance | { deps: FastifyInstance['deps'] },
  email: string,
  displayName: string,
  role: StaffRole,
) {
  const password = newToken(18);
  const totp = new OTPAuth.Secret({ size: 20 }).base32;
  const pool = getPool(app.deps.backofficeDbUrl!);
  const id = crypto.randomUUID();
  const enc = await seal(app.deps.keys, totp, { purpose: 'staff-totp', staff: id });
  await pool.query(
    `INSERT INTO backoffice.staff_users (id, email, display_name, role, password_hash, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, email, displayName, role, await hashPassword(password), JSON.stringify(enc)],
  );
  return { id, password, totpSecret: totp };
}

export async function backofficeAuthRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const cookie = staffCookie(deps.config);
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookie.name, token, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
      path: cookie.path,
    });

  app.post(
    '/v1/backoffice/auth/login',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          password: Type.String({ maxLength: 256 }),
        }),
        response: { 200: Type.Object({ mfaRequired: Type.Literal(true) }), 401: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { email: string; password: string };
      await throttle(deps, [
        [`staff:ip:${req.ctx.ip}`, 20, 900],
        [`staff:acct:${b.email.toLowerCase()}`, 5, 900],
      ]);
      const { rows } = await backofficePool(app).query<{
        id: string;
        password_hash: string | null;
        active: boolean;
      }>('SELECT id, password_hash, active FROM backoffice.staff_users WHERE email = $1', [b.email]);
      const u = rows[0];
      if (!u?.password_hash || !u.active) {
        await burnPasswordCheck(b.password);
        await staffAudit(app, req, 'staff.login_failed', { reason: u ? 'inactive' : 'unknown' });
        throw new ApiError('invalidCredentials');
      }
      if (!(await verifyPassword(u.password_hash, b.password))) {
        req.staff = { staffId: u.id, role: 'support', email: '' };
        await staffAudit(app, req, 'staff.login_failed', { reason: 'invalid' });
        throw new ApiError('invalidCredentials');
      }
      const token = newToken();
      await backofficePool(app).query(
        `INSERT INTO backoffice.staff_sessions (staff_id, token_hash, expires_at, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)`,
        [
          u.id,
          hashToken(token),
          new Date(deps.now().getTime() + STAFF_ABSOLUTE_HOURS * 3_600_000),
          deps.now(),
        ],
      );
      req.staff = { staffId: u.id, role: 'support', email: b.email };
      await staffAudit(app, req, 'staff.login');
      setCookie(reply, token);
      return { mfaRequired: true as const };
    },
  );

  app.post(
    '/v1/backoffice/auth/totp',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['backoffice'],
        body: Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }),
        response: { 204: Type.Null(), 401: Problem },
      },
    },
    async (req, reply) => {
      const token = req.cookies?.[cookie.name];
      if (!token) throw new ApiError('unauthorised');
      const pool = backofficePool(app);
      const { rows } = await pool.query<{ id: string; staff_id: string; totp_secret_enc: Envelope }>(
        `SELECT s.id, s.staff_id, u.totp_secret_enc FROM backoffice.staff_sessions s JOIN backoffice.staff_users u ON u.id = s.staff_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
        [hashToken(token), deps.now()],
      );
      const s = rows[0];
      if (!s) throw new ApiError('unauthorised');
      await throttle(deps, [[`staff:totp:${s.staff_id}`, 5, 300]]);
      const secret = await open(deps.keys, s.totp_secret_enc, { purpose: 'staff-totp', staff: s.staff_id });
      const at = deps.now().getTime();
      const delta = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret),
        digits: 6,
        period: 30,
      }).validate({ token: (req.body as { code: string }).code, timestamp: at, window: 1 });
      // Each time step is accepted once (ASVS V6.5.1): the update only succeeds for a newer step.
      const step = delta === null ? null : Math.floor(at / 30_000) + delta;
      const fresh =
        step !== null &&
        (
          await pool.query(
            'UPDATE backoffice.staff_users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
            [s.staff_id, step],
          )
        ).rowCount === 1;
      if (!fresh) {
        req.staff = { staffId: s.staff_id, role: 'support', email: '' };
        await staffAudit(app, req, 'staff.mfa_failed');
        throw new ApiError('invalidCredentials');
      }
      await pool.query('UPDATE backoffice.staff_sessions SET mfa_verified_at = now() WHERE id = $1', [s.id]);
      req.staff = { staffId: s.staff_id, role: 'support', email: '' };
      await staffAudit(app, req, 'staff.mfa_verified');
      return reply.status(204).send(null);
    },
  );

  // Who is signed in (the back-office UI uses this; 403 mfaRequired until the TOTP step is done).
  app.get(
    '/v1/backoffice/auth/session',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support', 'rules_editor', 'billing', 'security_analyst']),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({
            staffId: Type.String(),
            email: Type.String(),
            displayName: Type.String(),
            role: Type.String(),
            cell: Type.String(),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async (req) => {
      const { rows } = await backofficePool(app).query<{ display_name: string }>(
        'SELECT display_name FROM backoffice.staff_users WHERE id = $1',
        [req.staff!.staffId],
      );
      return {
        staffId: req.staff!.staffId,
        email: req.staff!.email,
        displayName: rows[0]?.display_name ?? '',
        role: req.staff!.role,
        cell: deps.config.cell,
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
        const { rows } = await backofficePool(app).query<{ staff_id: string }>(
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
