import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { isLocale, t, type Locale } from '@thapsus/core/i18n';
import { isAdmin } from '@thapsus/core/permissions';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem, Uuid } from '../../http/schemas';
import { emitSecurityEvent } from '../../lib/security-events';
import {
  assertPasswordlessAllowed,
  resolveTenantSlug,
  sendInBackground,
  throttle,
  uniformDelay,
} from './common';
import { revokeUserSessions } from './sessions';
import { assertAccountAuthority } from './session-routes';
import { ACCOUNT_LIMITS, AUTH_WINDOW_SECONDS, tenantBudget, tenantKey } from './throttles';
import {
  composeToken,
  hashPassword,
  hashToken,
  newToken,
  parseToken,
  passwordProblems,
  RESET_PREFIX,
} from './tokens';

/**
 * Forgotten passwords (ADR-0171; ASVS V6.4.3, V6.3.4, V6.5.5; plan 2.1.7):
 *  - anyone asks for a reset link from the sign-in page; the answer is the same, after the same time,
 *    whether or not the account exists, and requests are throttled per account, per workspace and per IP;
 *  - the link carries a single-use, 256-bit token, stored only as a SHA-256 hash, valid for 30 minutes
 *    (24 hours when an admin sent it) and scoped to resetting a password: it never signs anyone in;
 *  - the reset applies the password policy, ends every session, clears a lockout, is audited, and the
 *    person is told by email. It does not touch second factors: whoever has one uses it at the next sign-in;
 *  - an admin can send the link (never see or set the password), under the same rule as resetting
 *    two-step verification (assertAccountAuthority).
 */
export const RESET_LINK_MINUTES = 30;
export const ADMIN_RESET_LINK_HOURS = 24;

const localeOf = (l: string | null | undefined): Locale => (isLocale(l) ? l : 'en-GB');

/** Issues a reset link, ending any earlier unused one for the person (so only the newest works). */
async function issueResetLink(
  tx: Tx,
  tenantId: string,
  userId: string,
  expiresAt: Date,
  issuedBy: string | null,
): Promise<string> {
  await tx.exec(
    `UPDATE app.magic_links SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
    [userId],
  );
  const secret = newToken();
  await tx.exec(
    `INSERT INTO app.magic_links (tenant_id, user_id, token_hash, expires_at, purpose, issued_by)
     VALUES (app.current_tenant(), $1, $2, $3, 'password_reset', $4)`,
    [userId, hashToken(secret), expiresAt, issuedBy],
  );
  return composeToken(RESET_PREFIX, tenantId, secret);
}

export async function passwordResetRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const resetUrl = (token: string) =>
    `${deps.config.appBaseUrl}/auth/reset?token=${encodeURIComponent(token)}`;

  app.post(
    '/v1/auth/password-reset',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Ask for a password-reset link by email (the same answer whether or not the account exists)',
        body: Type.Object(
          {
            tenant: Type.String({ minLength: 3, maxLength: 40 }),
            email: Type.String({ format: 'email', maxLength: 254 }),
          },
          { additionalProperties: false },
        ),
        response: { 202: Type.Null(), 403: Problem, 404: Problem, 421: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const started = performance.now();
      const { tenant, email } = req.body as { tenant: string; email: string };
      const account = { tenant: tenant.toLowerCase(), email: email.toLowerCase() };
      await throttle(
        deps,
        [
          [`reset:ip:${req.ctx.ip}`, ACCOUNT_LIMITS.resetRequestsPerIp, AUTH_WINDOW_SECONDS],
          [
            `reset:acct:${account.tenant}:${account.email}`,
            ACCOUNT_LIMITS.resetRequests,
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
      const found = await withTenant(deps.router, tenantId, async (tx) => {
        // When the workspace requires SSO, passwords are not used at all (the same for every account).
        await assertPasswordlessAllowed(tx);
        const user = await tx.maybe<{ id: string; locale: string | null }>(
          `SELECT id, locale FROM app.users WHERE email = $1 AND status = 'active'`,
          [account.email],
        );
        if (!user) return undefined;
        const token = await issueResetLink(
          tx,
          tenantId,
          user.id,
          new Date(deps.now().getTime() + RESET_LINK_MINUTES * 60_000),
          null,
        );
        await writeAudit(tx, {
          actorType: 'user',
          actorId: user.id,
          action: 'auth.password_reset_requested',
          targetType: 'user',
          targetId: user.id,
          diff: { initiatedBy: 'self', validMinutes: RESET_LINK_MINUTES },
          ip: req.ctx.ip,
          userAgent: req.ctx.userAgent,
          requestId: req.id,
        });
        return { userId: user.id, token, locale: localeOf(user.locale) };
      });
      emitSecurityEvent(deps, req, {
        type: 'auth.password_reset_requested',
        severity: 'low',
        tenantId,
        userId: found?.userId,
        account: found ? undefined : account,
        detail: { initiatedBy: 'self', knownAccount: !!found },
      });
      if (found)
        sendInBackground(deps, req, {
          to: account.email,
          subject: t(found.locale, 'auth.passwordResetSubject'),
          text: t(found.locale, 'auth.passwordResetBody', {
            link: resetUrl(found.token),
            minutes: RESET_LINK_MINUTES,
          }),
        });
      await uniformDelay(started);
      return reply.status(202).send(null);
    },
  );

  app.post(
    '/v1/auth/password-reset/complete',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Set a new password with a reset link; every session ends and the person is told by email',
        description:
          'The link is single-use and does not sign you in: sign in with the new password afterwards, and with your second factor if you have one.',
        body: Type.Object(
          { token: Type.String({ maxLength: 200 }), newPassword: Type.String({ maxLength: 256 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ workspace: Type.String() }),
          400: Problem,
          401: Problem,
          403: Problem,
          429: Problem,
        },
      },
    },
    async (req) => {
      const b = req.body as { token: string; newPassword: string };
      await throttle(
        deps,
        [[`reset-complete:ip:${req.ctx.ip}`, ACCOUNT_LIMITS.resetCompletionsPerIp, AUTH_WINDOW_SECONDS]],
        req,
      );
      const parsed = parseToken(RESET_PREFIX, b.token);
      if (!parsed) throw new ApiError('invalidCredentials', 'resetLinkInvalid');
      const done = await withTenant(deps.router, parsed.tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const link = await tx.maybe<{
          id: string;
          user_id: string;
          issued_by: string | null;
          email: string;
          display_name: string;
          locale: string | null;
          name: string;
          slug: string;
        }>(
          `SELECT l.id, l.user_id, l.issued_by, u.email, u.display_name, u.locale, t.name, t.slug
             FROM app.magic_links l
             JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
             JOIN app.tenants t ON t.tenant_id = l.tenant_id
            WHERE l.token_hash = $1 AND l.purpose = 'password_reset' AND l.used_at IS NULL AND l.expires_at > $2
              AND u.status = 'active'
            FOR UPDATE OF l`,
          [hashToken(parsed.secret), deps.now()],
        );
        if (!link) throw new ApiError('invalidCredentials', 'resetLinkInvalid');
        // A refused password keeps the link usable, so the person can choose another one.
        const problems = passwordProblems(b.newPassword, {
          companyName: link.name,
          workspaceSlug: link.slug,
          email: link.email,
          displayName: link.display_name,
        });
        if (problems.length)
          throw new ApiError('validation', undefined, {
            errors: problems.map((p) => ({ path: '/newPassword', message: p })),
          });
        await tx.exec('UPDATE app.magic_links SET used_at = now() WHERE id = $1', [link.id]);
        await tx.exec(
          `INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
          [link.user_id, await hashPassword(b.newPassword)],
        );
        // Proving control of the mailbox ends a lockout, as a successful sign-in would.
        await tx.exec('UPDATE app.users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [
          link.user_id,
        ]);
        const endedSessions = await revokeUserSessions(tx, link.user_id);
        await writeAudit(tx, {
          actorType: 'user',
          actorId: link.user_id,
          action: 'auth.password_reset_completed',
          targetType: 'user',
          targetId: link.user_id,
          diff: { endedSessions, initiatedBy: link.issued_by ? 'admin' : 'self' },
          ip: req.ctx.ip,
          userAgent: req.ctx.userAgent,
          requestId: req.id,
        });
        req.auditWritten = true;
        return { ...link, endedSessions };
      });
      emitSecurityEvent(deps, req, {
        type: 'auth.password_reset_completed',
        severity: 'low',
        tenantId: parsed.tenantId,
        userId: done.user_id,
        detail: { initiatedBy: done.issued_by ? 'admin' : 'self', endedSessions: done.endedSessions },
      });
      const locale = localeOf(done.locale);
      sendInBackground(deps, req, {
        to: done.email,
        subject: t(locale, 'auth.passwordChangedSubject'),
        text: t(locale, 'auth.passwordChangedBody', {
          link: `${deps.config.appBaseUrl}/signin?workspace=${encodeURIComponent(done.slug)}`,
        }),
      });
      return { workspace: done.slug };
    },
  );

  app.post(
    '/v1/users/:userId/password-reset',
    {
      config: { selfAudited: true, capability: 'settings.users.manage' },
      schema: {
        tags: ['roles'],
        summary: 'Email a person a link to set a new password (you never see or set it)',
        description:
          'Needs company-wide settings.manage, every permission the person holds, and a recent sign-in or re-authentication; never for yourself. The link works once, for 24 hours. Their sessions end when they use it; their second factor is unchanged.',
        params: Type.Object({ userId: Uuid }),
        response: {
          202: Type.Object({ expiresAt: Type.String() }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const { userId } = req.params as { userId: string };
      const expiresAt = new Date(deps.now().getTime() + ADMIN_RESET_LINK_HOURS * 3_600_000);
      const out = await app.tenantTx(req, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const { target, ...user } = await assertAccountAuthority(tx, auth, userId, deps.now());
        if (user.status !== 'active') throw new ApiError('conflict', 'accountNotActive');
        const company = await tx.one<{ name: string }>('SELECT name FROM app.tenants');
        const token = await issueResetLink(tx, auth.tenantId, userId, expiresAt, auth.userId);
        await app.audit(tx, req, {
          action: 'auth.password_reset_sent',
          targetType: 'user',
          targetId: userId,
          diff: { validHours: ADMIN_RESET_LINK_HOURS, targetIsAdmin: isAdmin(target) },
        });
        return { token, email: user.email, locale: localeOf(user.locale), company: company.name };
      });
      emitSecurityEvent(deps, req, {
        type: 'auth.password_reset_requested',
        severity: 'medium',
        tenantId: auth.tenantId,
        userId,
        detail: { initiatedBy: 'admin', by: auth.userId },
      });
      await deps.mailer.send({
        to: out.email,
        subject: t(out.locale, 'auth.passwordResetByAdminSubject'),
        text: t(out.locale, 'auth.passwordResetByAdminBody', {
          link: resetUrl(out.token),
          hours: ADMIN_RESET_LINK_HOURS,
          company: out.company,
        }),
      });
      return reply.status(202).send({ expiresAt: expiresAt.toISOString() });
    },
  );
}
