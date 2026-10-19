import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import * as OTPAuth from 'otpauth';
import { getPool } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { open, seal, type Envelope } from '../../lib/kms';
import { throttle } from '../auth/common';
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from '../auth/tokens';

/**
 * Thapsus staff authentication for the back office: password + mandatory TOTP, 8-hour sessions.
 * Staff data lives in the backoffice schema and is reached only with the thapsus_backoffice role.
 */
export const STAFF_COOKIE = 'thr_staff';
export type StaffRole = 'super_admin' | 'support' | 'rules_editor' | 'billing';

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

export async function staffAudit(app: FastifyInstance, req: FastifyRequest, action: string, detail: Record<string, unknown> = {}, subjectTenantId?: string | null) {
  await backofficePool(app).query(
    `INSERT INTO backoffice.staff_audit (staff_id, action, subject_tenant_id, target, detail, ip, request_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.staff?.staffId ?? null, action, subjectTenantId ?? null, req.routeOptions.url, JSON.stringify(detail), req.ctx.ip, req.id],
  );
}

/** preHandler: requires a staff session with MFA and one of the roles. */
export function requireStaff(app: FastifyInstance, roles: StaffRole[]) {
  return async (req: FastifyRequest) => {
    const token = req.cookies?.[STAFF_COOKIE];
    if (!token) throw new ApiError('unauthorised');
    const { rows } = await backofficePool(app).query<{ staff_id: string; role: StaffRole; email: string; mfa_verified_at: string | null }>(
      `SELECT s.staff_id, u.role, u.email, s.mfa_verified_at FROM backoffice.staff_sessions s JOIN backoffice.staff_users u ON u.id = s.staff_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.active`,
      [hashToken(token), app.deps.now()],
    );
    const s = rows[0];
    if (!s) throw new ApiError('unauthorised');
    if (!s.mfa_verified_at) throw new ApiError('mfaRequired');
    if (!roles.includes(s.role) && s.role !== 'super_admin') throw new ApiError('forbidden');
    req.staff = { staffId: s.staff_id, role: s.role, email: s.email };
  };
}

export async function createStaff(app: FastifyInstance | { deps: FastifyInstance['deps'] }, email: string, displayName: string, role: StaffRole) {
  const password = newToken(18);
  const totp = new OTPAuth.Secret({ size: 20 }).base32;
  const pool = getPool(app.deps.backofficeDbUrl!);
  const id = crypto.randomUUID();
  const enc = await seal(app.deps.keys, totp, { purpose: 'staff-totp', staff: id });
  await pool.query(`INSERT INTO backoffice.staff_users (id, email, display_name, role, password_hash, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, $6)`, [id, email, displayName, role, await hashPassword(password), JSON.stringify(enc)]);
  return { id, password, totpSecret: totp };
}

export async function backofficeAuthRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(STAFF_COOKIE, token, { httpOnly: true, secure: deps.config.apiBaseUrl.startsWith('https'), sameSite: 'strict', path: '/v1/backoffice' });

  app.post(
    '/v1/backoffice/auth/login',
    { config: { auth: 'public', selfAudited: true }, schema: { tags: ['backoffice'], body: Type.Object({ email: Type.String({ format: 'email' }), password: Type.String({ maxLength: 256 }) }), response: { 200: Type.Object({ mfaRequired: Type.Literal(true) }), 401: Problem, 429: Problem } } },
    async (req, reply) => {
      const b = req.body as { email: string; password: string };
      await throttle(deps, [[`staff:ip:${req.ctx.ip}`, 20, 900], [`staff:acct:${b.email.toLowerCase()}`, 5, 900]]);
      const { rows } = await backofficePool(app).query<{ id: string; password_hash: string | null; active: boolean }>('SELECT id, password_hash, active FROM backoffice.staff_users WHERE email = $1', [b.email]);
      const u = rows[0];
      if (!u?.password_hash || !u.active) {
        await burnPasswordCheck(b.password);
        throw new ApiError('invalidCredentials');
      }
      if (!(await verifyPassword(u.password_hash, b.password))) throw new ApiError('invalidCredentials');
      const token = newToken();
      await backofficePool(app).query(`INSERT INTO backoffice.staff_sessions (staff_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [u.id, hashToken(token), new Date(deps.now().getTime() + 8 * 3_600_000)]);
      req.staff = { staffId: u.id, role: 'support', email: b.email };
      await staffAudit(app, req, 'staff.login');
      setCookie(reply, token);
      return { mfaRequired: true as const };
    },
  );

  app.post(
    '/v1/backoffice/auth/totp',
    { config: { auth: 'public', selfAudited: true }, schema: { tags: ['backoffice'], body: Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }), response: { 204: Type.Null(), 401: Problem } } },
    async (req, reply) => {
      const token = req.cookies?.[STAFF_COOKIE];
      if (!token) throw new ApiError('unauthorised');
      const pool = backofficePool(app);
      const { rows } = await pool.query<{ id: string; staff_id: string; totp_secret_enc: Envelope }>(
        `SELECT s.id, s.staff_id, u.totp_secret_enc FROM backoffice.staff_sessions s JOIN backoffice.staff_users u ON u.id = s.staff_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [hashToken(token)],
      );
      const s = rows[0];
      if (!s) throw new ApiError('unauthorised');
      await throttle(deps, [[`staff:totp:${s.staff_id}`, 5, 300]]);
      const secret = await open(deps.keys, s.totp_secret_enc, { purpose: 'staff-totp', staff: s.staff_id });
      const ok = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).validate({ token: (req.body as { code: string }).code, timestamp: deps.now().getTime(), window: 1 }) !== null;
      if (!ok) throw new ApiError('invalidCredentials');
      await pool.query('UPDATE backoffice.staff_sessions SET mfa_verified_at = now() WHERE id = $1', [s.id]);
      req.staff = { staffId: s.staff_id, role: 'support', email: '' };
      await staffAudit(app, req, 'staff.mfa_verified');
      return reply.status(204).send(null);
    },
  );

  // Who is signed in (the back-office UI uses this; 403 mfaRequired until the TOTP step is done).
  app.get(
    '/v1/backoffice/auth/session',
    { config: { auth: 'public' }, preHandler: requireStaff(app, ['support', 'rules_editor', 'billing']), schema: { tags: ['backoffice'], response: { 200: Type.Object({ staffId: Type.String(), email: Type.String(), displayName: Type.String(), role: Type.String(), cell: Type.String() }), 401: Problem, 403: Problem } } },
    async (req) => {
      const { rows } = await backofficePool(app).query<{ display_name: string }>('SELECT display_name FROM backoffice.staff_users WHERE id = $1', [req.staff!.staffId]);
      return { staffId: req.staff!.staffId, email: req.staff!.email, displayName: rows[0]?.display_name ?? '', role: req.staff!.role, cell: deps.config.cell };
    },
  );

  app.post(
    '/v1/backoffice/auth/logout',
    { config: { auth: 'public', selfAudited: true }, schema: { tags: ['backoffice'], response: { 204: Type.Null() } } },
    async (req, reply) => {
      const token = req.cookies?.[STAFF_COOKIE];
      if (token) {
        const { rows } = await backofficePool(app).query<{ staff_id: string }>('UPDATE backoffice.staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING staff_id', [hashToken(token)]);
        if (rows[0]) {
          req.staff = { staffId: rows[0].staff_id, role: 'support', email: '' };
          await staffAudit(app, req, 'staff.logout');
        }
      }
      reply.clearCookie(STAFF_COOKIE, { path: '/v1/backoffice' });
      return reply.status(204).send(null);
    },
  );
}
