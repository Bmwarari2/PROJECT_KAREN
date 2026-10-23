import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { withTenant } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { requireAuth } from '../../http/context';
import { resolveTenantSlug, startSession, throttle } from './common';
import { assertPasswordlessAllowed, consumeChallenge } from './common';
import { revokeUserSessions } from './sessions';
import { requireRecentAuth } from './session-routes';

const uuidToBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** WebAuthn passkeys. User verification is required, so a passkey sign-in satisfies MFA. */
export async function passkeyRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const rpID = new URL(deps.config.appBaseUrl).hostname;
  const origin = deps.config.appBaseUrl;
  const rpName = 'Thapsus-HR';

  app.post(
    '/v1/auth/passkeys/register/options',
    {
      config: { auth: 'mfa-setup', selfAudited: true },
      schema: {
        tags: ['auth'],
        response: { 200: Type.Object({ challengeId: Type.String(), options: Type.Any() }) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (auth.hasMfaFactor && !auth.mfaVerified) throw new ApiError('mfaRequired');
      // Adding a factor next to an existing one needs a fresh proof of identity (ASVS V7.5.1).
      if (auth.hasMfaFactor) requireRecentAuth(auth, deps.now());
      return app.tenantTx(req, async (tx) => {
        const existing = await tx.query<{ credential_id: string; transports: string[] }>(
          'SELECT credential_id, transports FROM app.passkeys WHERE user_id = $1',
          [auth.userId],
        );
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: auth.user.email,
          userDisplayName: auth.user.displayName,
          userID: uuidToBytes(auth.userId),
          attestationType: 'none',
          excludeCredentials: existing.map((c) => ({
            id: c.credential_id,
            transports: c.transports as never,
          })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });
        const ch = await tx.one<{ id: string }>(
          `INSERT INTO app.auth_challenges (tenant_id, user_id, kind, challenge, expires_at) VALUES (app.current_tenant(), $1, 'passkey_register', $2, now() + interval '5 minutes') RETURNING id`,
          [auth.userId, options.challenge],
        );
        return { challengeId: ch.id, options };
      });
    },
  );

  app.post(
    '/v1/auth/passkeys/register/verify',
    {
      config: { auth: 'mfa-setup', selfAudited: true },
      schema: {
        tags: ['auth'],
        body: Type.Object({
          challengeId: Type.String({ format: 'uuid' }),
          response: Type.Any(),
          name: Type.Optional(Type.String({ maxLength: 80 })),
        }),
        response: { 204: Type.Null(), 401: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = req.body as {
        challengeId: string;
        response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
        name?: string;
      };
      const ch = await consumeChallenge(
        deps,
        auth.tenantId,
        body.challengeId,
        'passkey_register',
        auth.userId,
      );
      if (!ch) throw new ApiError('invalidCredentials');
      await app.tenantTx(req, async (tx) => {
        const result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: ch.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        }).catch(() => undefined);
        if (!result?.verified || !result.registrationInfo) throw new ApiError('invalidCredentials');
        const cred = result.registrationInfo.credential;
        await tx.exec(
          `INSERT INTO app.passkeys (tenant_id, user_id, credential_id, public_key, counter, transports, name) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6)`,
          [
            auth.userId,
            cred.id,
            Buffer.from(cred.publicKey),
            cred.counter,
            cred.transports ?? [],
            body.name ?? null,
          ],
        );
        await tx.exec(
          'UPDATE app.sessions SET mfa_verified_at = coalesce(mfa_verified_at, now()) WHERE id = $1',
          [auth.sessionId],
        );
        // A new authenticator ends every other session (ASVS V7.4.3).
        const otherSessionsEnded = await revokeUserSessions(tx, auth.userId, auth.sessionId);
        await app.audit(tx, req, {
          action: 'auth.passkey_registered',
          targetType: 'user',
          targetId: auth.userId,
          diff: { otherSessionsEnded },
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/auth/passkeys/login/options',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        body: Type.Object({ tenant: Type.String({ maxLength: 40 }) }, { additionalProperties: false }),
        response: {
          200: Type.Object({ challengeId: Type.String(), options: Type.Any() }),
          403: Problem,
          429: Problem,
        },
      },
    },
    async (req) => {
      await throttle(deps, [[`passkey:ip:${req.ctx.ip}`, 30, 900]]);
      const tenantId = await resolveTenantSlug(deps, (req.body as { tenant: string }).tenant);
      return withTenant(deps.router, tenantId, async (tx) => {
        await assertPasswordlessAllowed(tx);
        const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
        const ch = await tx.one<{ id: string }>(
          `INSERT INTO app.auth_challenges (tenant_id, kind, challenge, expires_at) VALUES (app.current_tenant(), 'passkey_login', $1, now() + interval '5 minutes') RETURNING id`,
          [options.challenge],
        );
        return { challengeId: `${tenantId}.${ch.id}`, options };
      });
    },
  );

  app.post(
    '/v1/auth/passkeys/login/verify',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        body: Type.Object({ challengeId: Type.String({ maxLength: 80 }), response: Type.Any() }),
        response: { 200: Type.Object({ tenantId: Type.String(), userId: Type.String() }), 401: Problem },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        challengeId: string;
        response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
      };
      const [tenantId, challengeId] = body.challengeId.split('.');
      if (!tenantId || !challengeId) throw new ApiError('invalidCredentials');
      const ch = await consumeChallenge(deps, tenantId, challengeId, 'passkey_login');
      return withTenant(deps.router, tenantId, async (tx) => {
        const cred = await tx.maybe<{
          id: string;
          user_id: string;
          credential_id: string;
          public_key: Buffer;
          counter: string;
          transports: string[];
        }>(
          'SELECT id, user_id, credential_id, public_key, counter, transports FROM app.passkeys WHERE credential_id = $1',
          [body.response?.id],
        );
        if (!ch || !cred) throw new ApiError('invalidCredentials');
        if (body.response.response?.userHandle) {
          const handle = bytesToUuid(Buffer.from(body.response.response.userHandle, 'base64url'));
          if (handle !== cred.user_id) throw new ApiError('invalidCredentials');
        }
        const result = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: ch.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: cred.credential_id,
            publicKey: new Uint8Array(cred.public_key),
            counter: Number(cred.counter),
            transports: cred.transports as never,
          },
        }).catch(() => undefined);
        if (!result?.verified) throw new ApiError('invalidCredentials');
        await tx.exec('UPDATE app.passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [
          cred.id,
          result.authenticationInfo.newCounter,
        ]);
        await startSession(deps, req, reply, tx, {
          tenantId,
          userId: cred.user_id,
          method: 'passkey',
          mfaVerified: true,
        });
        return { tenantId, userId: cred.user_id };
      });
    },
  );
}
