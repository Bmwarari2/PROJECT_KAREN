import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@thapsus/db';
import { isAdmin } from '@thapsus/core/permissions';
import { t } from '@thapsus/core/i18n';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { requireAuth } from '../../http/context';
import { burnPasswordCheck, composeToken, hashPassword, hashToken, MAGIC_PREFIX, newToken, parseToken, passwordProblems, verifyPassword } from './tokens';
import { assertPasswordlessAllowed, clearSessionCookie, recordFailure, resolveTenantSlug, startSession, throttle } from './common';
import { loadSecurity, revokeUserSessions } from './sessions';
import { seal } from '../../lib/kms';
import { checkTotp, totpContext, totpFor } from './totp';
import { requireRecentAuth, sessionRoutes } from './session-routes';

const SessionInfo = Type.Object({
  tenantId: Type.String({ format: 'uuid' }),
  userId: Type.String({ format: 'uuid' }),
  mfaRequired: Type.Boolean(),
  mfaEnrollmentRequired: Type.Boolean(),
});

export { MAGIC_PREFIX };

export async function authRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.post(
    '/v1/auth/login',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        body: Type.Object({
          tenant: Type.String({ minLength: 3, maxLength: 40 }),
          email: Type.String({ format: 'email', maxLength: 254 }),
          password: Type.String({ minLength: 1, maxLength: 256 }),
        }, { additionalProperties: false }),
        response: { 200: SessionInfo, 401: Problem, 403: Problem, 404: Problem, 421: Problem, 423: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const { tenant, email, password } = req.body as { tenant: string; email: string; password: string };
      await throttle(deps, [
        [`login:ip:${req.ctx.ip}`, 50, 900],
        [`login:acct:${tenant}:${email.toLowerCase()}`, 10, 900],
      ]);
      const tenantId = await resolveTenantSlug(deps, tenant);
      const found = await withTenant(deps.router, tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        return tx.maybe<{ id: string; status: string; locked_until: string | null; password_hash: string | null }>(
          `SELECT u.id, u.status, u.locked_until, c.password_hash FROM app.users u
             LEFT JOIN app.password_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id
            WHERE u.email = $1`,
          [email],
        );
      });
      if (found?.locked_until && new Date(found.locked_until) > deps.now()) {
        await recordFailure(deps, req, tenantId, found.id, 'locked');
        throw new ApiError('lockedOut');
      }
      if (!found || found.status !== 'active' || !found.password_hash) {
        await burnPasswordCheck(password);
        await recordFailure(deps, req, tenantId, found?.id, 'invalid');
        throw new ApiError('invalidCredentials');
      }
      if (!(await verifyPassword(found.password_hash, password))) {
        await recordFailure(deps, req, tenantId, found.id, 'invalid');
        throw new ApiError('invalidCredentials');
      }
      return withTenant(deps.router, tenantId, async (tx) => {
        await startSession(deps, req, reply, tx, { tenantId, userId: found.id, method: 'password', mfaVerified: false });
        const factor = await tx.maybe(
          `SELECT 1 FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NOT NULL UNION ALL SELECT 1 FROM app.passkeys WHERE user_id = $1 LIMIT 1`,
          [found.id],
        );
        const { loadPrincipal } = await import('../authz/principal');
        const admin = isAdmin(await loadPrincipal(tx, found.id));
        return { tenantId, userId: found.id, mfaRequired: !!factor, mfaEnrollmentRequired: admin && !factor };
      });
    },
  );

  app.post('/v1/auth/logout', { config: { auth: 'mfa-setup', selfAudited: true }, schema: { tags: ['auth'], response: { 204: Type.Null() } } }, async (req, reply) => {
    const auth = requireAuth(req);
    await app.tenantTx(req, async (tx) => {
      await tx.exec('UPDATE app.sessions SET revoked_at = now() WHERE id = $1', [auth.sessionId]);
      await app.audit(tx, req, { action: 'auth.logout', targetType: 'user', targetId: auth.userId });
    });
    clearSessionCookie(deps, reply);
    // The browser drops anything it cached for this origin (HTTP and back/forward caches). The web
    // client also reloads the page so no personal data stays in memory (ASVS V14.3.1).
    reply.header('Clear-Site-Data', '"cache"');
    return reply.status(204).send(null);
  });

  app.get(
    '/v1/auth/session',
    {
      config: { auth: 'mfa-setup' },
      schema: {
        tags: ['auth'],
        response: {
          200: Type.Object({
            tenantId: Type.String(),
            userId: Type.String(),
            email: Type.String(),
            displayName: Type.String(),
            locale: Type.Union([Type.String(), Type.Null()]),
            timeZone: Type.Union([Type.String(), Type.Null()]),
            employeeId: Type.Union([Type.String(), Type.Null()]),
            method: Type.String(),
            mfaVerified: Type.Boolean(),
            hasMfaFactor: Type.Boolean(),
            /** Whether a password is set (people invited by link or SSO may have none). */
            hasPassword: Type.Boolean(),
            isAdmin: Type.Boolean(),
            roles: Type.Array(Type.String()),
            permissions: Type.Array(Type.String()),
          }),
        },
      },
    },
    async (req) => {
      const a = requireAuth(req);
      const hasPassword = a.apiClient ? false : !!(await app.tenantTx(req, (tx) => tx.maybe('SELECT 1 FROM app.password_credentials WHERE user_id = $1', [a.userId]), { readOnly: true }));
      return {
        tenantId: a.tenantId,
        userId: a.userId,
        email: a.user.email,
        displayName: a.user.displayName,
        locale: a.user.locale,
        timeZone: a.user.timeZone,
        employeeId: a.user.employeeId,
        method: a.method,
        mfaVerified: a.mfaVerified,
        hasMfaFactor: a.hasMfaFactor,
        hasPassword,
        isAdmin: isAdmin(a.principal),
        roles: [...new Set(a.principal.grants.map((g) => g.roleKey))],
        permissions: [...new Set(a.principal.grants.flatMap((g) => g.permissions))],
      };
    },
  );

  // ---- TOTP ---------------------------------------------------------------------------------
  const ctx = totpContext;

  app.post(
    '/v1/auth/mfa/totp/enroll',
    {
      config: { auth: 'mfa-setup', selfAudited: true },
      schema: { tags: ['auth'], response: { 200: Type.Object({ factorId: Type.String(), secret: Type.String(), otpauthUrl: Type.String() }) } },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (auth.hasMfaFactor && !auth.mfaVerified) throw new ApiError('mfaRequired');
      // Changing an existing second factor needs a fresh proof of identity (ASVS V7.5.1).
      if (auth.hasMfaFactor) requireRecentAuth(auth, deps.now());
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const envelope = await seal(deps.keys, secret, ctx(auth.tenantId, auth.userId));
      const row = await app.tenantTx(req, async (tx) => {
        await tx.exec('DELETE FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NULL', [auth.userId]);
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.totp_factors (tenant_id, user_id, secret_enc) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
          [auth.userId, JSON.stringify(envelope)],
        );
        await app.audit(tx, req, { action: 'auth.mfa.totp_enroll_started', targetType: 'user', targetId: auth.userId });
        return r;
      });
      return { factorId: row.id, secret, otpauthUrl: totpFor(secret, auth.user.email).toString() };
    },
  );

  for (const [path, filter] of [
    ['/v1/auth/mfa/totp/confirm', 'pending'],
    ['/v1/auth/mfa/totp/verify', 'verified'],
  ] as const) {
    app.post(
      path,
      {
        config: { auth: 'mfa-setup', selfAudited: true },
        schema: { tags: ['auth'], body: Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }), response: { 204: Type.Null(), 401: Problem, 429: Problem } },
      },
      async (req, reply) => {
        const auth = requireAuth(req);
        await throttle(deps, [[`totp:${auth.userId}`, 5, 300]]);
        const ok = await checkTotp(deps, auth.tenantId, auth.userId, (req.body as { code: string }).code, filter);
        await app.tenantTx(req, async (tx) => {
          if (ok) await tx.exec('UPDATE app.sessions SET mfa_verified_at = now() WHERE id = $1', [auth.sessionId]);
          // A new authenticator ends every other session (ASVS V7.4.3): a stolen session cannot outlive the change.
          const otherSessionsEnded = ok && filter === 'pending' ? await revokeUserSessions(tx, auth.userId, auth.sessionId) : undefined;
          await app.audit(tx, req, {
            action: ok ? `auth.mfa.${filter === 'pending' ? 'totp_enrolled' : 'verified'}` : 'auth.mfa.failed',
            targetType: 'user',
            targetId: auth.userId,
            ...(otherSessionsEnded !== undefined ? { diff: { otherSessionsEnded } } : {}),
          });
        });
        if (!ok) throw new ApiError('invalidCredentials');
        return reply.status(204).send(null);
      },
    );
  }

  // ---- Magic links --------------------------------------------------------------------------
  app.post(
    '/v1/auth/magic-link',
    {
      config: { auth: 'public', selfAudited: true },
      schema: { tags: ['auth'], body: Type.Object({ tenant: Type.String({ maxLength: 40 }), email: Type.String({ format: 'email', maxLength: 254 }) }, { additionalProperties: false }), response: { 202: Type.Null(), 403: Problem, 429: Problem } },
    },
    async (req, reply) => {
      const { tenant, email } = req.body as { tenant: string; email: string };
      await throttle(deps, [
        [`magic:ip:${req.ctx.ip}`, 20, 900],
        [`magic:acct:${tenant}:${email.toLowerCase()}`, 3, 900],
      ]);
      const tenantId = await resolveTenantSlug(deps, tenant);
      const result = await withTenant(deps.router, tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const user = await tx.maybe<{ id: string; locale: string | null }>(`SELECT id, locale FROM app.users WHERE email = $1 AND status = 'active'`, [email]);
        if (!user) return undefined;
        const secret = newToken();
        await tx.exec(
          `INSERT INTO app.magic_links (tenant_id, user_id, token_hash, expires_at) VALUES (app.current_tenant(), $1, $2, $3)`,
          [user.id, hashToken(secret), new Date(deps.now().getTime() + 15 * 60_000)],
        );
        return { token: composeToken(MAGIC_PREFIX, tenantId, secret), locale: user.locale === 'en-US' ? 'en-US' : 'en-GB' } as const;
      });
      if (result) {
        const link = `${deps.config.appBaseUrl}/auth/magic?token=${encodeURIComponent(result.token)}`;
        await deps.mailer.send({
          to: email,
          subject: t(result.locale, 'auth.magicLinkSubject'),
          text: t(result.locale, 'auth.magicLinkBody', { link }),
        });
      }
      return reply.status(202).send(null);
    },
  );

  app.post(
    '/v1/auth/magic-link/consume',
    {
      config: { auth: 'public', selfAudited: true },
      schema: { tags: ['auth'], body: Type.Object({ token: Type.String({ maxLength: 200 }) }), response: { 200: SessionInfo, 401: Problem, 403: Problem } },
    },
    async (req, reply) => {
      const parsed = parseToken(MAGIC_PREFIX, (req.body as { token: string }).token);
      if (!parsed) throw new ApiError('invalidCredentials');
      await throttle(deps, [[`magic-consume:ip:${req.ctx.ip}`, 30, 900]]);
      return withTenant(deps.router, parsed.tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const link = await tx.maybe<{ id: string; user_id: string }>(
          `UPDATE app.magic_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING id, user_id`,
          [hashToken(parsed.secret), deps.now()],
        );
        if (!link) throw new ApiError('invalidCredentials');
        await startSession(deps, req, reply, tx, { tenantId: parsed.tenantId, userId: link.user_id, method: 'magic_link', mfaVerified: false });
        const { loadPrincipal } = await import('../authz/principal');
        const admin = isAdmin(await loadPrincipal(tx, link.user_id));
        const factor = await tx.maybe(`SELECT 1 FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NOT NULL UNION ALL SELECT 1 FROM app.passkeys WHERE user_id = $1 LIMIT 1`, [link.user_id]);
        return { tenantId: parsed.tenantId, userId: link.user_id, mfaRequired: !!factor, mfaEnrollmentRequired: admin && !factor };
      });
    },
  );

  // ---- Password change ------------------------------------------------------------------------
  app.post(
    '/v1/auth/password',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Change (or set a first) password; ends your other sessions',
        description: 'The current password is required when one exists. Setting a first password (for people invited by link or SSO) needs a recent sign-in or re-authentication.',
        body: Type.Object({ currentPassword: Type.Optional(Type.String({ maxLength: 256 })), newPassword: Type.String({ maxLength: 256 }) }, { additionalProperties: false }),
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword: string };
      await throttle(deps, [[`password-change:${auth.userId}`, 5, 900]]);
      await app.tenantTx(req, async (tx) => {
        const who = await tx.one<{ name: string; slug: string; email: string; display_name: string }>(
          'SELECT t.name, t.slug, u.email, u.display_name FROM app.users u JOIN app.tenants t ON t.tenant_id = u.tenant_id WHERE u.id = $1',
          [auth.userId],
        );
        const problems = passwordProblems(newPassword, { companyName: who.name, workspaceSlug: who.slug, email: who.email, displayName: who.display_name });
        if (problems.length) throw new ApiError('validation', undefined, { errors: problems.map((p) => ({ path: '/newPassword', message: p })) });
        const cred = await tx.maybe<{ password_hash: string }>('SELECT password_hash FROM app.password_credentials WHERE user_id = $1', [auth.userId]);
        if (cred) {
          if (!(await verifyPassword(cred.password_hash, currentPassword ?? ''))) throw new ApiError('invalidCredentials');
        } else {
          // a first password is a new authentication factor (ASVS V7.5.1)
          requireRecentAuth(auth, deps.now());
        }
        await tx.exec(
          `INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
          [auth.userId, await hashPassword(newPassword)],
        );
        // Every other session ends (ASVS V7.4.3); this one stays, and the password just proved identity.
        const otherSessionsEnded = await revokeUserSessions(tx, auth.userId, auth.sessionId);
        await tx.exec('UPDATE app.sessions SET reauthenticated_at = $2 WHERE id = $1', [auth.sessionId, deps.now()]);
        await app.audit(tx, req, { action: cred ? 'auth.password_changed' : 'auth.password_set', targetType: 'user', targetId: auth.userId, diff: { otherSessionsEnded } });
      });
      return reply.status(204).send(null);
    },
  );

  await app.register(sessionRoutes);

  app.get('/v1/auth/security', { schema: { tags: ['auth'], hide: true } }, async (req) => {
    requireAuth(req);
    return app.tenantTx(req, (tx) => loadSecurity(tx), { readOnly: true });
  });
}
