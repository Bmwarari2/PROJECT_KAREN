import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { isLocale, t } from '@thapsus/core/i18n';
import { uncoveredPermissions } from '@thapsus/core/access';
import { isAdmin } from '@thapsus/core/permissions';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem, Uuid } from '../../http/schemas';
import { loadPrincipal } from '../authz/principal';
import { setSessionCookie, throttle } from './common';
import {
  recentlyAuthenticated,
  REAUTH_WINDOW_MINUTES,
  revokeUserSessions,
  SESSION_PREFIX,
  type AuthContext,
} from './sessions';
import { composeToken, hashToken, newToken, verifyPassword } from './tokens';
import { checkTotp } from './totp';

/**
 * Session management and step-up re-authentication (ASVS V7.4.3, V7.4.5, V7.5.1, V7.5.2, V6.4.4;
 * ADR-0131):
 *  - POST /v1/auth/reauth proves the user's identity again (password or authenticator code); the
 *    sign-in itself counts for REAUTH_WINDOW_MINUTES;
 *  - people see their own active sessions and end any or all of the others (after re-authenticating);
 *  - company-wide admins (settings.manage) end one person's sessions, or everyone's;
 *  - an admin who holds everything the person holds resets a lost second factor after confirming the
 *    person's identity out of band (the same proof the employer used to invite them).
 */
const SessionOut = Type.Object({
  id: Uuid,
  method: Type.String(),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  current: Type.Boolean(),
  /** The browser's user agent as it sent it at sign-in (shortened), so people can recognise devices. */
  device: Type.Union([Type.String(), Type.Null()]),
});

export function requireRecentAuth(auth: AuthContext, now: Date) {
  if (!recentlyAuthenticated(auth, now))
    throw new ApiError('reauthenticationRequired', undefined, { windowMinutes: REAUTH_WINDOW_MINUTES });
}

export async function sessionRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.post(
    '/v1/auth/reauth',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Prove your identity again before a sensitive change (password or authenticator code)',
        body: Type.Union([
          Type.Object(
            { password: Type.String({ minLength: 1, maxLength: 256 }) },
            { additionalProperties: false },
          ),
          Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }, { additionalProperties: false }),
        ]),
        response: { 204: Type.Null(), 401: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { password?: string; code?: string };
      await throttle(deps, [[`reauth:${auth.userId}`, 5, 300]]);
      let ok = false;
      if (b.password !== undefined) {
        const cred = await app.tenantTx(
          req,
          (tx) =>
            tx.maybe<{ password_hash: string }>(
              'SELECT password_hash FROM app.password_credentials WHERE user_id = $1',
              [auth.userId],
            ),
          { readOnly: true },
        );
        ok = !!cred && (await verifyPassword(cred.password_hash, b.password));
      } else if (b.code !== undefined) {
        ok = await checkTotp(deps, auth.tenantId, auth.userId, b.code, 'verified');
      }
      const rotated = await app.tenantTx(req, async (tx) => {
        let token: string | undefined;
        if (ok) {
          // re-authentication issues a new session token and the old one stops working (ASVS V7.2.4)
          const secret = newToken();
          await tx.exec('UPDATE app.sessions SET reauthenticated_at = $2, token_hash = $3 WHERE id = $1', [
            auth.sessionId,
            deps.now(),
            hashToken(secret),
          ]);
          token = composeToken(SESSION_PREFIX, auth.tenantId, secret);
        }
        await app.audit(tx, req, {
          action: ok ? 'auth.reauthenticated' : 'auth.reauth_failed',
          targetType: 'user',
          targetId: auth.userId,
          diff: { factor: b.password !== undefined ? 'password' : 'totp' },
        });
        return token;
      });
      if (!rotated) throw new ApiError('invalidCredentials');
      setSessionCookie(deps, reply, rotated);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/auth/sessions',
    {
      schema: {
        tags: ['auth'],
        summary: 'Your active sessions on every device',
        response: {
          200: Type.Object({ data: Type.Array(SessionOut), reauthenticatedRecently: Type.Boolean() }),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            auth_method: string;
            created_at: string;
            last_seen_at: string;
            user_agent: string | null;
          }>(
            `SELECT id, auth_method, created_at, last_seen_at, user_agent FROM app.sessions
              WHERE user_id = $1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2
              ORDER BY last_seen_at DESC LIMIT 100`,
            [auth.userId, deps.now()],
          ),
        { readOnly: true },
      );
      return {
        data: rows.map((r) => ({
          id: r.id,
          method: r.auth_method,
          createdAt: new Date(r.created_at).toISOString(),
          lastSeenAt: new Date(r.last_seen_at).toISOString(),
          current: r.id === auth.sessionId,
          device: r.user_agent?.slice(0, 200) ?? null,
        })),
        reauthenticatedRecently: recentlyAuthenticated(auth, deps.now()),
      };
    },
  );

  app.delete(
    '/v1/auth/sessions/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'End one of your other sessions (needs a recent sign-in or re-authentication)',
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      if (id === auth.sessionId) throw new ApiError('validation', 'Use sign out to end this session');
      requireRecentAuth(auth, deps.now());
      await app.tenantTx(req, async (tx) => {
        const n = await tx.exec(
          'UPDATE app.sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
          [id, auth.userId],
        );
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'auth.session_ended', targetType: 'session', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/auth/sessions/end-others',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'End all your sessions except this one (needs a recent sign-in or re-authentication)',
        response: { 200: Type.Object({ ended: Type.Integer() }), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      requireRecentAuth(auth, deps.now());
      return app.tenantTx(req, async (tx) => {
        const ended = await revokeUserSessions(tx, auth.userId, auth.sessionId);
        await app.audit(tx, req, {
          action: 'auth.other_sessions_ended',
          targetType: 'user',
          targetId: auth.userId,
          diff: { ended },
        });
        return { ended };
      });
    },
  );

  // ---- administrators --------------------------------------------------------------------------------------
  app.post(
    '/v1/users/:userId/sessions/end',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['roles'],
        summary: 'Sign a person out everywhere (company-wide settings.manage)',
        params: Type.Object({ userId: Uuid }),
        response: { 200: Type.Object({ ended: Type.Integer() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { userId } = req.params as { userId: string };
      return app.tenantTx(req, async (tx) => {
        const user = await tx.maybe('SELECT 1 FROM app.users WHERE id = $1', [userId]);
        if (!user) throw new ApiError('notFound');
        const ended = await revokeUserSessions(
          tx,
          userId,
          userId === auth.userId ? auth.sessionId : undefined,
        );
        await app.audit(tx, req, {
          action: 'auth.user_sessions_ended',
          targetType: 'user',
          targetId: userId,
          diff: { ended },
        });
        return { ended };
      });
    },
  );

  app.post(
    '/v1/settings/sessions/end-all',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary: 'Sign everyone in the workspace out, except your own current session',
        response: { 200: Type.Object({ ended: Type.Integer() }), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      requireRecentAuth(auth, deps.now());
      return app.tenantTx(req, async (tx) => {
        const ended = await tx.exec(
          'UPDATE app.sessions SET revoked_at = now() WHERE revoked_at IS NULL AND id <> $1',
          [auth.sessionId],
        );
        await app.audit(tx, req, {
          action: 'auth.all_sessions_ended',
          targetType: 'tenant',
          diff: { ended },
        });
        return { ended };
      });
    },
  );

  app.post(
    '/v1/users/:userId/mfa/reset',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['roles'],
        summary:
          'Remove a person’s lost second factors after confirming who they are; they set up a new one at their next sign-in',
        description:
          'Needs company-wide settings.manage, every permission the person holds, and a recent sign-in or re-authentication. You cannot reset your own factors. The person is signed out everywhere and told by email.',
        params: Type.Object({ userId: Uuid }),
        body: Type.Object({ identityConfirmed: Type.Literal(true) }, { additionalProperties: false }),
        response: {
          200: Type.Object({ removedFactors: Type.Integer(), endedSessions: Type.Integer() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { userId } = req.params as { userId: string };
      if (userId === auth.userId) throw new ApiError('forbidden', 'ownFactors');
      requireRecentAuth(auth, deps.now());
      const out = await app.tenantTx(req, async (tx) => {
        const user = await tx.maybe<{ email: string; locale: string | null }>(
          'SELECT email, locale FROM app.users WHERE id = $1',
          [userId],
        );
        if (!user) throw new ApiError('notFound');
        const target = await loadPrincipal(tx, userId);
        const companyWide = auth.principal.grants.filter((g) => g.scope.type === 'all');
        const missing = uncoveredPermissions(companyWide, [
          ...new Set(target.grants.flatMap((g) => g.permissions)),
        ]);
        if (missing.length)
          throw new ApiError('forbidden', 'exceedsYourAccess', {
            reason: 'exceedsYourAccess',
            permissions: missing,
          });
        const totp = await tx.exec('DELETE FROM app.totp_factors WHERE user_id = $1', [userId]);
        const passkeys = await tx.exec('DELETE FROM app.passkeys WHERE user_id = $1', [userId]);
        const endedSessions = await revokeUserSessions(tx, userId);
        await app.audit(tx, req, {
          action: 'auth.mfa_reset',
          targetType: 'user',
          targetId: userId,
          diff: {
            removedFactors: totp + passkeys,
            endedSessions,
            targetIsAdmin: isAdmin(target),
            identityConfirmedBy: auth.userId,
          },
        });
        return {
          removedFactors: totp + passkeys,
          endedSessions,
          email: user.email,
          locale: isLocale(user.locale) ? user.locale : ('en-GB' as const),
        };
      });
      await deps.mailer.send({
        to: out.email,
        subject: t(out.locale, 'auth.mfaResetSubject'),
        text: t(out.locale, 'auth.mfaResetBody', { link: `${deps.config.appBaseUrl}/signin` }),
      });
      return { removedFactors: out.removedFactors, endedSessions: out.endedSessions };
    },
  );
}
