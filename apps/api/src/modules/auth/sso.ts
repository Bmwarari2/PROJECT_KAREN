import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import * as oidc from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { authorize } from '../../http/context';
import { resolveTenantSlug, startSession, throttle } from './common';
import { loadSecurity } from './sessions';
import { assignRole } from '../authz/principal';
import { open, seal, type Envelope } from '../../lib/kms';

interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecretEnc?: Envelope;
  scopes?: string;
}
interface SamlConfig {
  entryPoint: string;
  idpIssuer?: string;
  idpCert: string;
}

const oidcCache = new Map<string, { config: oidc.Configuration; at: number }>();

export async function ssoRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const api = deps.config.apiBaseUrl;
  const oidcCallback = `${api}/v1/auth/sso/oidc/callback`;
  const samlAcs = `${api}/v1/auth/sso/saml/acs`;
  const spEntityId = (tenantId: string, connId: string) => `${api}/v1/auth/sso/saml/metadata/${tenantId}/${connId}`;
  const secretCtx = (tenantId: string, connId: string) => ({ tenant: tenantId, purpose: 'sso', connection: connId });

  async function oidcConfig(tenantId: string, connId: string, cfg: OidcConfig): Promise<oidc.Configuration> {
    const key = `${tenantId}:${connId}:${cfg.issuer}:${cfg.clientId}`;
    const hit = oidcCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.config;
    const secret = cfg.clientSecretEnc ? await open(deps.keys, cfg.clientSecretEnc, secretCtx(tenantId, connId)) : undefined;
    const insecure = cfg.issuer.startsWith('http://') && deps.config.env !== 'prod';
    const config = await oidc.discovery(new URL(cfg.issuer), cfg.clientId, secret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
    oidcCache.set(key, { config, at: Date.now() });
    return config;
  }

  function samlClient(tenantId: string, connId: string, cfg: SamlConfig) {
    return new SAML({
      callbackUrl: samlAcs,
      entryPoint: cfg.entryPoint,
      issuer: spEntityId(tenantId, connId),
      audience: spEntityId(tenantId, connId),
      idpCert: cfg.idpCert,
      idpIssuer: cfg.idpIssuer,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: 60_000,
      validateInResponseTo: 'never' as never,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      disableRequestedAuthnContext: true,
    });
  }

  async function connection(tx: Tx, connId?: string) {
    const conn = await tx.maybe<{ id: string; protocol: 'oidc' | 'saml'; config: OidcConfig & SamlConfig; jit_provisioning: boolean }>(
      `SELECT id, protocol, config, jit_provisioning FROM app.sso_connections WHERE enabled ${connId ? 'AND id = $1' : ''} ORDER BY created_at LIMIT 1`,
      connId ? [connId] : [],
    );
    if (!conn) throw new ApiError('notFound');
    return conn;
  }

  /** Finds (or just-in-time provisions) the user for an IdP-asserted email. */
  async function userForAssertedEmail(tx: Tx, email: string, displayName: string | undefined, jit: boolean): Promise<string> {
    const user = await tx.maybe<{ id: string; status: string }>('SELECT id, status FROM app.users WHERE email = $1', [email]);
    if (user) {
      if (user.status !== 'active') throw new ApiError('forbidden');
      return user.id;
    }
    const domain = email.split('@')[1]?.toLowerCase();
    const verified = await tx.maybe('SELECT 1 FROM app.verified_domains WHERE domain = $1 AND verified_at IS NOT NULL', [domain]);
    if (!jit || !verified) throw new ApiError('forbidden');
    const created = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, status) VALUES (app.current_tenant(), $1, $2, 'active') RETURNING id`,
      [email, displayName || email.split('@')[0]],
    );
    await assignRole(tx, created.id, 'employee');
    await writeAudit(tx, { actorType: 'system', action: 'user.jit_provisioned', targetType: 'user', targetId: created.id });
    return created.id;
  }

  app.get(
    '/v1/auth/sso/start',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['auth'],
        summary: 'Begin SSO sign-in (redirects to the identity provider)',
        querystring: Type.Object({
          tenant: Type.String(),
          connection: Type.Optional(Type.String({ format: 'uuid' })),
          login_hint: Type.Optional(Type.String({ maxLength: 254 })),
        }),
        response: { 302: Type.Null(), 404: Problem, 421: Problem },
      },
    },
    async (req, reply) => {
      const q = req.query as { tenant: string; connection?: string; login_hint?: string };
      await throttle(deps, [[`sso:ip:${req.ctx.ip}`, 60, 900]]);
      const tenantId = await resolveTenantSlug(deps, q.tenant);
      const url = await withTenant(deps.router, tenantId, async (tx) => {
        const conn = await connection(tx, q.connection);
        if (conn.protocol === 'oidc') {
          const config = await oidcConfig(tenantId, conn.id, conn.config);
          const verifier = oidc.randomPKCECodeVerifier();
          const nonce = oidc.randomNonce();
          const ch = await tx.one<{ id: string }>(
            `INSERT INTO app.auth_challenges (tenant_id, kind, challenge, data, expires_at) VALUES (app.current_tenant(), 'oidc', $1, $2, now() + interval '10 minutes') RETURNING id`,
            [nonce, JSON.stringify({ verifier, connectionId: conn.id })],
          );
          const params: Record<string, string> = {
            redirect_uri: oidcCallback,
            scope: conn.config.scopes ?? 'openid email profile',
            code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256',
            state: `${tenantId}.${ch.id}`,
            nonce,
          };
          if (q.login_hint) params.login_hint = q.login_hint;
          return oidc.buildAuthorizationUrl(config, params).href;
        }
        const ch = await tx.one<{ id: string }>(
          `INSERT INTO app.auth_challenges (tenant_id, kind, challenge, data, expires_at) VALUES (app.current_tenant(), 'saml', 'relay', $1, now() + interval '10 minutes') RETURNING id`,
          [JSON.stringify({ connectionId: conn.id })],
        );
        const saml = samlClient(tenantId, conn.id, conn.config);
        const href = await saml.getAuthorizeUrlAsync(`${tenantId}.${ch.id}`, undefined, {});
        return q.login_hint ? `${href}&login_hint=${encodeURIComponent(q.login_hint)}` : href;
      });
      return reply.redirect(url, 302);
    },
  );

  async function finish(req: FastifyRequest, reply: FastifyReply, tenantId: string, tx: Tx, email: string, name: string | undefined, method: 'oidc' | 'saml', jit: boolean) {
    const userId = await userForAssertedEmail(tx, email.toLowerCase(), name, jit);
    const security = await loadSecurity(tx);
    await startSession(deps, req, reply, tx, { tenantId, userId, method, mfaVerified: security.trustIdpMfa });
    return reply.redirect(`${deps.config.appBaseUrl}/app`, 302);
  }

  app.get(
    '/v1/auth/sso/oidc/callback',
    { config: { auth: 'public', selfAudited: true }, schema: { tags: ['auth'], querystring: Type.Object({ state: Type.String(), code: Type.Optional(Type.String()), error: Type.Optional(Type.String()) }, { additionalProperties: true }), response: { 302: Type.Null(), 401: Problem } } },
    async (req, reply) => {
      const q = req.query as { state: string; code?: string };
      const [tenantId, challengeId] = q.state.split('.');
      if (!tenantId || !challengeId || !q.code) throw new ApiError('invalidCredentials');
      return withTenant(deps.router, tenantId, async (tx) => {
        const ch = await tx.maybe<{ challenge: string; data: { verifier: string; connectionId: string } }>(
          `UPDATE app.auth_challenges SET used_at = now() WHERE id = $1 AND kind = 'oidc' AND used_at IS NULL AND expires_at > now() RETURNING challenge, data`,
          [challengeId],
        );
        if (!ch) throw new ApiError('invalidCredentials');
        const conn = await connection(tx, ch.data.connectionId);
        const config = await oidcConfig(tenantId, conn.id, conn.config);
        const current = new URL(`${api}${req.url}`);
        const tokens = await oidc
          .authorizationCodeGrant(config, current, { pkceCodeVerifier: ch.data.verifier, expectedState: q.state, expectedNonce: ch.challenge })
          .catch((err) => {
            req.log.warn({ err }, 'oidc code exchange failed');
            throw new ApiError('invalidCredentials');
          });
        const claims = tokens.claims();
        const email = typeof claims?.email === 'string' ? claims.email : undefined;
        if (!email || claims?.email_verified === false) throw new ApiError('invalidCredentials');
        return finish(req, reply, tenantId, tx, email, typeof claims?.name === 'string' ? claims.name : undefined, 'oidc', conn.jit_provisioning);
      });
    },
  );

  app.post(
    '/v1/auth/sso/saml/acs',
    { config: { auth: 'public', selfAudited: true }, schema: { tags: ['auth'], consumes: ['application/x-www-form-urlencoded'], body: Type.Object({ SAMLResponse: Type.String(), RelayState: Type.String() }), response: { 302: Type.Null(), 401: Problem } } },
    async (req, reply) => {
      const body = req.body as { SAMLResponse: string; RelayState: string };
      const [tenantId, challengeId] = body.RelayState.split('.');
      if (!tenantId || !challengeId) throw new ApiError('invalidCredentials');
      return withTenant(deps.router, tenantId, async (tx) => {
        const ch = await tx.maybe<{ data: { connectionId: string } }>(
          `UPDATE app.auth_challenges SET used_at = now() WHERE id = $1 AND kind = 'saml' AND used_at IS NULL AND expires_at > now() RETURNING data`,
          [challengeId],
        );
        if (!ch) throw new ApiError('invalidCredentials');
        const conn = await connection(tx, ch.data.connectionId);
        const result = await samlClient(tenantId, conn.id, conn.config)
          .validatePostResponseAsync({ SAMLResponse: body.SAMLResponse })
          .catch((err) => {
            req.log.warn({ err }, 'saml validation failed');
            throw new ApiError('invalidCredentials');
          });
        const profile = result.profile;
        const assertionId = (profile as { ID?: string } | null)?.ID ?? (profile as { sessionIndex?: string } | null)?.sessionIndex;
        if (!profile?.nameID) throw new ApiError('invalidCredentials');
        if (assertionId) {
          // Replay protection: each assertion id can be consumed once.
          const fresh = await tx.maybe(
            `INSERT INTO app.auth_challenges (tenant_id, kind, challenge, expires_at, used_at)
             SELECT app.current_tenant(), 'saml_assertion', $1, now() + interval '1 day', now()
             WHERE NOT EXISTS (SELECT 1 FROM app.auth_challenges WHERE kind = 'saml_assertion' AND challenge = $1) RETURNING id`,
            [assertionId],
          );
          if (!fresh) throw new ApiError('invalidCredentials');
        }
        const email = (profile.email as string | undefined) ?? profile.nameID;
        const name = (profile['displayName'] as string | undefined) ?? undefined;
        return finish(req, reply, tenantId, tx, email, name, 'saml', conn.jit_provisioning);
      });
    },
  );

  app.get(
    '/v1/auth/sso/saml/metadata/:tenantId/:connectionId',
    { config: { auth: 'public' }, schema: { tags: ['auth'], params: Type.Object({ tenantId: Type.String({ format: 'uuid' }), connectionId: Type.String({ format: 'uuid' }) }) } },
    async (req, reply) => {
      const p = req.params as { tenantId: string; connectionId: string };
      const xml = await withTenant(deps.router, p.tenantId, async (tx) => {
        const conn = await connection(tx, p.connectionId);
        if (conn.protocol !== 'saml') throw new ApiError('notFound');
        return samlClient(p.tenantId, conn.id, conn.config).generateServiceProviderMetadata(null, null);
      });
      return reply.type('application/samlmetadata+xml').send(xml);
    },
  );

  // ---- Admin: SSO connections and security policy ------------------------------------------
  const ConnectionBody = Type.Object({
    protocol: Type.Union([Type.Literal('oidc'), Type.Literal('saml')]),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    jitProvisioning: Type.Optional(Type.Boolean()),
    oidc: Type.Optional(Type.Object({ issuer: Type.String({ format: 'uri' }), clientId: Type.String(), clientSecret: Type.Optional(Type.String()), scopes: Type.Optional(Type.String()) })),
    saml: Type.Optional(Type.Object({ entryPoint: Type.String({ format: 'uri' }), idpIssuer: Type.Optional(Type.String()), idpCert: Type.String({ minLength: 20 }) })),
  });

  app.post(
    '/v1/settings/sso-connections',
    { config: { selfAudited: true }, schema: { tags: ['settings'], body: ConnectionBody, response: { 201: Type.Object({ id: Type.String(), acsUrl: Type.String(), redirectUri: Type.String(), spEntityId: Type.String() }), 400: Problem, 403: Problem } } },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const b = req.body as { protocol: 'oidc' | 'saml'; name: string; jitProvisioning?: boolean; oidc?: OidcConfig & { clientSecret?: string }; saml?: SamlConfig };
      const cfgInput = b.protocol === 'oidc' ? b.oidc : b.saml;
      if (!cfgInput) throw new ApiError('validation');
      const id = crypto.randomUUID();
      let config: Record<string, unknown> = { ...cfgInput };
      if (b.protocol === 'oidc' && b.oidc?.clientSecret) {
        const { clientSecret, ...rest } = b.oidc;
        config = { ...rest, clientSecretEnc: await seal(deps.keys, clientSecret, secretCtx(auth.tenantId, id)) };
      }
      await app.tenantTx(req, async (tx) => {
        await tx.exec(
          `INSERT INTO app.sso_connections (tenant_id, id, protocol, name, config, jit_provisioning) VALUES (app.current_tenant(), $1, $2, $3, $4, $5)`,
          [id, b.protocol, b.name, JSON.stringify(config), b.jitProvisioning ?? true],
        );
        await app.audit(tx, req, { action: 'sso.connection_created', targetType: 'sso_connection', targetId: id, diff: { protocol: b.protocol, name: b.name } });
      });
      return reply.status(201).send({ id, acsUrl: samlAcs, redirectUri: oidcCallback, spEntityId: spEntityId(auth.tenantId, id) });
    },
  );

  app.patch(
    '/v1/settings/security',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        body: Type.Object({
          ssoEnforced: Type.Optional(Type.Boolean()),
          sessionIdleMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 720 })),
          sessionAbsoluteHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
          lockoutThreshold: Type.Optional(Type.Integer({ minimum: 3, maximum: 20 })),
          lockoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
          trustIdpMfa: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }),
        response: { 200: Type.Any(), 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const patch = req.body as Record<string, unknown>;
      return app.tenantTx(req, async (tx) => {
        const before = await loadSecurity(tx);
        if (patch.ssoEnforced === true) {
          const conn = await tx.maybe('SELECT 1 FROM app.sso_connections WHERE enabled');
          if (!conn) throw new ApiError('unprocessable', 'An enabled SSO connection is required before enforcing SSO');
        }
        const after = { ...before, ...patch };
        await tx.exec('UPDATE app.tenants SET security = $1', [JSON.stringify(after)]);
        await app.audit(tx, req, { action: 'settings.security_updated', targetType: 'tenant', diff: { before, after } });
        return after;
      });
    },
  );
}
