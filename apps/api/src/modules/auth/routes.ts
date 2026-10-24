import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@thapsus/db';
import { isAdmin } from '@thapsus/core/permissions';
import { t } from '@thapsus/core/i18n';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { requireAuth } from '../../http/context';
import {
  burnPasswordCheck,
  composeToken,
  hashPassword,
  hashToken,
  MAGIC_PREFIX,
  newToken,
  parseToken,
  passwordProblems,
  verifyPassword,
} from './tokens';
import {
  assertFailureBudget,
  assertPasswordlessAllowed,
  clearSessionCookie,
  countFailure,
  recordFailure,
  resolveTenantSlug,
  sendInBackground,
  startSession,
  throttle,
  uniformDelay,
} from './common';
import {
  loadSecurity,
  mustUseMfa,
  recentlyAuthenticated,
  revokeUserSessions,
  signInNextStep,
} from './sessions';
import { ACCOUNT_LIMITS, AUTH_WINDOW_SECONDS, tenantBudget, tenantKey } from './throttles';
import { emitSecurityEvent } from '../../lib/security-events';
import { passwordResetRoutes } from './password-reset';
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
export const MAGIC_LINK_MINUTES = 10;

export async function authRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.post(
    '/v1/auth/login',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        body: Type.Object(
          {
            tenant: Type.String({ minLength: 3, maxLength: 40 }),
            email: Type.String({ format: 'email', maxLength: 254 }),
            password: Type.String({ minLength: 1, maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: SessionInfo,
          401: Problem,
          403: Problem,
          404: Problem,
          421: Problem,
          423: Problem,
          429: Problem,
        },
      },
    },
    async (req, reply) => {
      const { tenant, email, password } = req.body as { tenant: string; email: string; password: string };
      const account = { tenant: tenant.toLowerCase(), email: email.toLowerCase() };
      await throttle(
        deps,
        [
          [`login:ip:${req.ctx.ip}`, ACCOUNT_LIMITS.loginAttemptsPerIp, AUTH_WINDOW_SECONDS],
          [
            `login:acct:${account.tenant}:${account.email}`,
            ACCOUNT_LIMITS.loginAttempts,
            AUTH_WINDOW_SECONDS,
          ],
        ],
        req,
      );
      const tenantId = await resolveTenantSlug(deps, tenant);
      // Credential stuffing spread over many addresses and accounts: the workspace's failure budget.
      const failures = tenantKey('login-fail', tenantId);
      await assertFailureBudget(
        deps,
        req,
        failures,
        await tenantBudget(deps, tenantId, 'loginFailures'),
        tenantId,
      );
      const found = await withTenant(deps.router, tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        return tx.maybe<{
          id: string;
          status: string;
          locked_until: string | null;
          password_hash: string | null;
        }>(
          `SELECT u.id, u.status, u.locked_until, c.password_hash FROM app.users u
             LEFT JOIN app.password_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id
            WHERE u.email = $1`,
          [email],
        );
      });
      if (found?.locked_until && new Date(found.locked_until) > deps.now()) {
        await countFailure(deps, failures, AUTH_WINDOW_SECONDS);
        await recordFailure(deps, req, tenantId, found.id, 'locked');
        throw new ApiError('lockedOut');
      }
      if (!found || found.status !== 'active' || !found.password_hash) {
        await burnPasswordCheck(password);
        await countFailure(deps, failures, AUTH_WINDOW_SECONDS);
        await recordFailure(deps, req, tenantId, found?.id, 'invalid', account);
        throw new ApiError('invalidCredentials');
      }
      if (!(await verifyPassword(found.password_hash, password))) {
        await countFailure(deps, failures, AUTH_WINDOW_SECONDS);
        await recordFailure(deps, req, tenantId, found.id, 'invalid');
        throw new ApiError('invalidCredentials');
      }
      return withTenant(deps.router, tenantId, async (tx) => {
        await startSession(deps, req, reply, tx, {
          tenantId,
          userId: found.id,
          method: 'password',
          mfaVerified: false,
        });
        return { tenantId, userId: found.id, ...(await signInNextStep(tx, found.id)) };
      });
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      config: { auth: 'mfa-setup', selfAudited: true },
      schema: { tags: ['auth'], response: { 204: Type.Null() } },
    },
    async (req, reply) => {
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
    },
  );

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
            /**
             * A new password can be set without the current one: the person signed in with an emailed
             * link (or has no password yet) within the re-authentication window (ADR-0171).
             */
            passwordWithoutCurrent: Type.Boolean(),
            isAdmin: Type.Boolean(),
            /** This person must set up and use a second factor (every admin; everyone when the workspace requires it). */
            mustUseMfa: Type.Boolean(),
            roles: Type.Array(Type.String()),
            permissions: Type.Array(Type.String()),
          }),
        },
      },
    },
    async (req) => {
      const a = requireAuth(req);
      const hasPassword = a.apiClient
        ? false
        : !!(await app.tenantTx(
            req,
            (tx) => tx.maybe('SELECT 1 FROM app.password_credentials WHERE user_id = $1', [a.userId]),
            { readOnly: true },
          ));
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
        passwordWithoutCurrent:
          !a.apiClient && (a.method === 'magic_link' || !hasPassword) && recentlyAuthenticated(a, deps.now()),
        isAdmin: isAdmin(a.principal),
        mustUseMfa: mustUseMfa(a.principal, { requireMfaForEveryone: !!a.requireMfaForEveryone }),
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
      schema: {
        tags: ['auth'],
        response: {
          200: Type.Object({ factorId: Type.String(), secret: Type.String(), otpauthUrl: Type.String() }),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (auth.hasMfaFactor && !auth.mfaVerified) throw new ApiError('mfaRequired');
      // Changing an existing second factor needs a fresh proof of identity (ASVS V7.5.1).
      if (auth.hasMfaFactor) requireRecentAuth(auth, deps.now());
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const envelope = await seal(deps.keys, secret, ctx(auth.tenantId, auth.userId));
      const row = await app.tenantTx(req, async (tx) => {
        await tx.exec('DELETE FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NULL', [
          auth.userId,
        ]);
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.totp_factors (tenant_id, user_id, secret_enc) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
          [auth.userId, JSON.stringify(envelope)],
        );
        await app.audit(tx, req, {
          action: 'auth.mfa.totp_enroll_started',
          targetType: 'user',
          targetId: auth.userId,
        });
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
        schema: {
          tags: ['auth'],
          body: Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }),
          response: { 204: Type.Null(), 401: Problem, 429: Problem },
        },
      },
      async (req, reply) => {
        const auth = requireAuth(req);
        await throttle(
          deps,
          [
            [`totp:${auth.userId}`, ACCOUNT_LIMITS.mfaAttempts, 300],
            [`totp:ip:${req.ctx.ip}`, ACCOUNT_LIMITS.mfaAttemptsPerIp, AUTH_WINDOW_SECONDS],
          ],
          req,
        );
        const mfaFailures = tenantKey('mfa-fail', auth.tenantId);
        await assertFailureBudget(
          deps,
          req,
          mfaFailures,
          await tenantBudget(deps, auth.tenantId, 'mfaFailures'),
          auth.tenantId,
        );
        const ok = await checkTotp(
          deps,
          auth.tenantId,
          auth.userId,
          (req.body as { code: string }).code,
          filter,
        );
        await app.tenantTx(req, async (tx) => {
          if (ok)
            await tx.exec('UPDATE app.sessions SET mfa_verified_at = now() WHERE id = $1', [auth.sessionId]);
          // A new authenticator ends every other session (ASVS V7.4.3): a stolen session cannot outlive the change.
          const otherSessionsEnded =
            ok && filter === 'pending'
              ? await revokeUserSessions(tx, auth.userId, auth.sessionId)
              : undefined;
          await app.audit(tx, req, {
            action: ok
              ? `auth.mfa.${filter === 'pending' ? 'totp_enrolled' : 'verified'}`
              : 'auth.mfa.failed',
            targetType: 'user',
            targetId: auth.userId,
            ...(otherSessionsEnded !== undefined ? { diff: { otherSessionsEnded } } : {}),
          });
        });
        if (!ok) {
          await countFailure(deps, mfaFailures, AUTH_WINDOW_SECONDS);
          emitSecurityEvent(deps, req, {
            type: 'auth.mfa_failed',
            severity: 'low',
            tenantId: auth.tenantId,
            userId: auth.userId,
            detail: { factor: 'totp', step: filter === 'pending' ? 'enrolment' : 'sign_in' },
          });
          throw new ApiError('invalidCredentials');
        }
        return reply.status(204).send(null);
      },
    );
  }

  // ---- Magic links --------------------------------------------------------------------------
  app.post(
    '/v1/auth/magic-link',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        body: Type.Object(
          { tenant: Type.String({ maxLength: 40 }), email: Type.String({ format: 'email', maxLength: 254 }) },
          { additionalProperties: false },
        ),
        response: { 202: Type.Null(), 403: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const started = performance.now();
      const { tenant, email } = req.body as { tenant: string; email: string };
      await throttle(
        deps,
        [
          [`magic:ip:${req.ctx.ip}`, ACCOUNT_LIMITS.magicLinkRequestsPerIp, AUTH_WINDOW_SECONDS],
          [
            `magic:acct:${tenant.toLowerCase()}:${email.toLowerCase()}`,
            ACCOUNT_LIMITS.magicLinkRequests,
            AUTH_WINDOW_SECONDS,
          ],
        ],
        req,
      );
      const tenantId = await resolveTenantSlug(deps, tenant);
      await throttle(
        deps,
        [
          [
            tenantKey('email-links', tenantId),
            await tenantBudget(deps, tenantId, 'emailLinks'),
            AUTH_WINDOW_SECONDS,
          ],
        ],
        req,
      );
      const result = await withTenant(deps.router, tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const user = await tx.maybe<{ id: string; locale: string | null }>(
          `SELECT id, locale FROM app.users WHERE email = $1 AND status = 'active'`,
          [email],
        );
        if (!user) return undefined;
        const secret = newToken();
        await tx.exec(
          `INSERT INTO app.magic_links (tenant_id, user_id, token_hash, expires_at, purpose) VALUES (app.current_tenant(), $1, $2, $3, 'sign_in')`,
          // an emailed (out-of-band) sign-in token lives at most 10 minutes (ASVS V6.5.5)
          [user.id, hashToken(secret), new Date(deps.now().getTime() + MAGIC_LINK_MINUTES * 60_000)],
        );
        return {
          token: composeToken(MAGIC_PREFIX, tenantId, secret),
          locale: user.locale === 'en-US' ? 'en-US' : 'en-GB',
        } as const;
      });
      if (result) {
        const link = `${deps.config.appBaseUrl}/auth/magic?token=${encodeURIComponent(result.token)}`;
        sendInBackground(deps, req, {
          to: email,
          subject: t(result.locale, 'auth.magicLinkSubject'),
          text: t(result.locale, 'auth.magicLinkBody', { link }),
        });
      }
      // The same answer, after the same time, whether or not the account exists (plan 2.1.7).
      await uniformDelay(started);
      return reply.status(202).send(null);
    },
  );

  app.post(
    '/v1/auth/magic-link/consume',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        body: Type.Object({ token: Type.String({ maxLength: 200 }) }),
        response: { 200: SessionInfo, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const parsed = parseToken(MAGIC_PREFIX, (req.body as { token: string }).token);
      if (!parsed) throw new ApiError('invalidCredentials');
      await throttle(deps, [[`magic-consume:ip:${req.ctx.ip}`, 30, 900]], req);
      return withTenant(deps.router, parsed.tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        // Only sign-in links and invitations sign someone in; a password-reset link never does (ADR-0171).
        const link = await tx.maybe<{ id: string; user_id: string }>(
          `UPDATE app.magic_links SET used_at = now()
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 AND purpose IN ('sign_in', 'invitation')
            RETURNING id, user_id`,
          [hashToken(parsed.secret), deps.now()],
        );
        if (!link) throw new ApiError('invalidCredentials');
        await startSession(deps, req, reply, tx, {
          tenantId: parsed.tenantId,
          userId: link.user_id,
          method: 'magic_link',
          mfaVerified: false,
        });
        return {
          tenantId: parsed.tenantId,
          userId: link.user_id,
          ...(await signInNextStep(tx, link.user_id)),
        };
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
        description:
          'The current password is required when one exists, except within the re-authentication window after signing in with an emailed link (ADR-0171). Setting a first password (for people invited by link or SSO) needs a recent sign-in or re-authentication.',
        body: Type.Object(
          {
            currentPassword: Type.Optional(Type.String({ maxLength: 256 })),
            newPassword: Type.String({ maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (auth.apiClient) throw new ApiError('forbidden');
      const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword: string };
      await throttle(deps, [[`password-change:${auth.userId}`, 5, 900]], req);
      let viaEmailLink = false;
      const notice = await app.tenantTx(req, async (tx) => {
        const who = await tx.one<{
          name: string;
          slug: string;
          email: string;
          display_name: string;
          locale: string | null;
        }>(
          'SELECT t.name, t.slug, u.email, u.display_name, u.locale FROM app.users u JOIN app.tenants t ON t.tenant_id = u.tenant_id WHERE u.id = $1',
          [auth.userId],
        );
        const problems = passwordProblems(newPassword, {
          companyName: who.name,
          workspaceSlug: who.slug,
          email: who.email,
          displayName: who.display_name,
        });
        if (problems.length)
          throw new ApiError('validation', undefined, {
            errors: problems.map((p) => ({ path: '/newPassword', message: p })),
          });
        const cred = await tx.maybe<{ password_hash: string }>(
          'SELECT password_hash FROM app.password_credentials WHERE user_id = $1',
          [auth.userId],
        );
        if (cred && currentPassword !== undefined) {
          if (!(await verifyPassword(cred.password_hash, currentPassword)))
            throw new ApiError('invalidCredentials');
        } else if (cred && auth.method === 'magic_link') {
          // Someone who forgot their password signs in with an emailed link and sets a new one: the link
          // proved control of the mailbox, as a reset link does, and the second-factor gate still applied
          // to this session. Only within the re-authentication window (ASVS V6.4.3, V7.5.1; ADR-0171).
          requireRecentAuth(auth, deps.now());
          viaEmailLink = true;
        } else if (cred) {
          throw new ApiError('invalidCredentials');
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
        await tx.exec('UPDATE app.sessions SET reauthenticated_at = $2 WHERE id = $1', [
          auth.sessionId,
          deps.now(),
        ]);
        await app.audit(tx, req, {
          action: cred ? 'auth.password_changed' : 'auth.password_set',
          targetType: 'user',
          targetId: auth.userId,
          diff: { otherSessionsEnded, ...(viaEmailLink ? { via: 'email_link' } : {}) },
        });
        return { email: who.email, locale: who.locale === 'en-US' ? ('en-US' as const) : ('en-GB' as const) };
      });
      if (viaEmailLink) {
        emitSecurityEvent(deps, req, {
          type: 'auth.password_set_after_email_link',
          severity: 'low',
          tenantId: auth.tenantId,
          userId: auth.userId,
        });
        sendInBackground(deps, req, {
          to: notice.email,
          subject: t(notice.locale, 'auth.passwordChangedSubject'),
          text: t(notice.locale, 'auth.passwordChangedBody', { link: `${deps.config.appBaseUrl}/signin` }),
        });
      }
      return reply.status(204).send(null);
    },
  );

  await app.register(sessionRoutes);
  await app.register(passwordResetRoutes);

  app.get('/v1/auth/security', { schema: { tags: ['auth'], hide: true } }, async (req) => {
    requireAuth(req);
    return app.tenantTx(req, (tx) => loadSecurity(tx), { readOnly: true });
  });
}
