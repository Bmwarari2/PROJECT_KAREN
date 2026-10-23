import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import { Type } from 'typebox';
import * as oidc from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { authorize } from '../../http/context';
import { consumeChallenge, resolveTenantSlug, startSession, throttle } from './common';
import { loadSecurity } from './sessions';
import { assignRole } from '../authz/principal';
import { open, seal, type Envelope } from '../../lib/kms';
import { ssoBindingCookie } from '../../http/security';
import { hashToken, newToken, safeEqual } from './tokens';

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
/** XML signature and digest algorithm URIs built on SHA-1 or MD5. */
export const WEAK_XMLDSIG = /Algorithm\s*=\s*["']http:\/\/www\.w3\.org\/(2000\/09\/xmldsig#(rsa-sha1|dsa-sha1|hmac-sha1|sha1)|2001\/04\/xmldsig-more#(rsa-md5|md5|hmac-md5)|2009\/xmldsig11#dsa-sha1)["']/i;

export async function ssoRoutes(app: FastifyInstance) {
  const deps = app.deps;
  // The SAML HTTP-POST binding delivers the assertion as a urlencoded form (only routes in this scope parse it).
  await app.register(formbody);
  const api = deps.config.apiBaseUrl;
  const oidcCallback = `${api}/v1/auth/sso/oidc/callback`;
  const samlAcs = `${api}/v1/auth/sso/saml/acs`;
  const spEntityId = (tenantId: string, connId: string) => `${api}/v1/auth/sso/saml/metadata/${tenantId}/${connId}`;
  const secretCtx = (tenantId: string, connId: string) => ({ tenant: tenantId, purpose: 'sso', connection: connId });
  const binding_ = ssoBindingCookie(deps.config);

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
          // bound to this browser: only a redirect that comes back with the cookie can finish (ASVS V10.1.2)
          const binding = newToken(16);
          const ch = await tx.one<{ id: string }>(
            `INSERT INTO app.auth_challenges (tenant_id, kind, challenge, data, expires_at) VALUES (app.current_tenant(), 'oidc', $1, $2, now() + interval '10 minutes') RETURNING id`,
            [nonce, JSON.stringify({ verifier, connectionId: conn.id, binding: hashToken(binding).toString('base64url') })],
          );
          reply.setCookie(binding_.name, binding, { httpOnly: true, secure: binding_.secure, sameSite: 'lax', path: binding_.path, maxAge: 600 });
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

  /** Failed SSO sign-ins are audited in the tenant they name (ASVS V16.3.1); unknown tenants are ignored. */
  const auditFailure = (method: 'oidc' | 'saml', pick: (req: FastifyRequest) => string | undefined) => async (req: FastifyRequest, _reply: FastifyReply, err: Error) => {
    const tenantId = pick(req)?.split('.')[0];
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) return;
    const reason = err instanceof ApiError ? err.code : 'error';
    await withTenant(deps.router, tenantId, (tx) => writeAudit(tx, { actorType: 'user', action: 'auth.login_failed', diff: { method, reason }, ip: req.ctx.ip, userAgent: req.ctx.userAgent, requestId: req.id })).catch(() => undefined);
  };

  async function finish(req: FastifyRequest, reply: FastifyReply, tenantId: string, tx: Tx, email: string, name: string | undefined, method: 'oidc' | 'saml', jit: boolean) {
    const userId = await userForAssertedEmail(tx, email.toLowerCase(), name, jit);
    const security = await loadSecurity(tx);
    await startSession(deps, req, reply, tx, { tenantId, userId, method, mfaVerified: security.trustIdpMfa });
  }

  app.get(
    '/v1/auth/sso/oidc/callback',
    {
      config: { auth: 'public', selfAudited: true },
      onError: auditFailure('oidc', (req) => (req.query as { state?: string }).state),
      schema: { tags: ['auth'], querystring: Type.Object({ state: Type.String(), code: Type.Optional(Type.String()), error: Type.Optional(Type.String()) }, { additionalProperties: true }), response: { 302: Type.Null(), 401: Problem } },
    },
    async (req, reply) => {
      const q = req.query as { state: string; code?: string };
      const [tenantId, challengeId] = q.state.split('.');
      if (!tenantId || !challengeId || !q.code) throw new ApiError('invalidCredentials');
      const ch = await consumeChallenge<{ verifier: string; connectionId: string; binding?: string }>(deps, tenantId, challengeId, 'oidc');
      reply.clearCookie(binding_.name, { path: binding_.path, secure: binding_.secure, httpOnly: true, sameSite: 'lax' });
      if (!ch) throw new ApiError('invalidCredentials');
      const presented = req.cookies?.[binding_.name];
      if (!ch.data.binding || !presented || !safeEqual(hashToken(presented), Buffer.from(ch.data.binding, 'base64url'))) {
        req.log.warn('oidc callback without the browser binding');
        throw new ApiError('invalidCredentials');
      }
      await withTenant(deps.router, tenantId, async (tx) => {
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
        await finish(req, reply, tenantId, tx, email, typeof claims?.name === 'string' ? claims.name : undefined, 'oidc', conn.jit_provisioning);
      });
      // Redirect only after the session row has committed.
      return reply.redirect(`${deps.config.appBaseUrl}/app`, 302);
    },
  );

  app.post(
    '/v1/auth/sso/saml/acs',
    {
      // The identity provider's page posts here cross-site by design; the signed assertion, the one-time
      // RelayState and the assertion replay cache are what protect it (ADR-0130).
      config: { auth: 'public', selfAudited: true, crossSite: true },
      onError: auditFailure('saml', (req) => (req.body as { RelayState?: string } | undefined)?.RelayState),
      schema: { tags: ['auth'], consumes: ['application/x-www-form-urlencoded'], body: Type.Object({ SAMLResponse: Type.String({ maxLength: 500_000 }), RelayState: Type.String({ maxLength: 200 }) }), response: { 302: Type.Null(), 401: Problem } },
    },
    async (req, reply) => {
      const body = req.body as { SAMLResponse: string; RelayState: string };
      const [tenantId, challengeId] = body.RelayState.split('.');
      if (!tenantId || !challengeId) throw new ApiError('invalidCredentials');
      const ch = await consumeChallenge<{ connectionId: string }>(deps, tenantId, challengeId, 'saml');
      if (!ch) throw new ApiError('invalidCredentials');
      // Only SHA-2 signatures and digests: SHA-1 (or MD5) signed responses are refused (ASVS V11.4.1).
      if (WEAK_XMLDSIG.test(Buffer.from(body.SAMLResponse, 'base64').toString('utf8'))) {
        req.log.warn('saml response signed with a weak algorithm');
        throw new ApiError('invalidCredentials');
      }
      await withTenant(deps.router, tenantId, async (tx) => {
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
        await finish(req, reply, tenantId, tx, email, name, 'saml', conn.jit_provisioning);
      });
      return reply.redirect(`${deps.config.appBaseUrl}/app`, 302);
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
      return reply.type('application/samlmetadata+xml; charset=utf-8').send(xml);
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

  // ---- Admin screens: read the policy, list / enable / remove connections ----------------------
  const SecurityOut = Type.Object({
    ssoEnforced: Type.Boolean(),
    sessionIdleMinutes: Type.Integer(),
    sessionAbsoluteHours: Type.Integer(),
    lockoutThreshold: Type.Integer(),
    lockoutMinutes: Type.Integer(),
    trustIdpMfa: Type.Boolean(),
  });
  app.get('/v1/settings/security', { schema: { tags: ['settings'], summary: 'Tenant sign-in policy (SSO enforcement, session timeouts, lockout, IdP MFA trust)', response: { 200: SecurityOut, 403: Problem } } }, async (req) => {
    authorize(req, 'settings.read');
    const s = await app.tenantTx(req, (tx) => loadSecurity(tx), { readOnly: true });
    return { ssoEnforced: s.ssoEnforced, sessionIdleMinutes: s.sessionIdleMinutes, sessionAbsoluteHours: s.sessionAbsoluteHours, lockoutThreshold: s.lockoutThreshold, lockoutMinutes: s.lockoutMinutes, trustIdpMfa: s.trustIdpMfa };
  });

  const ConnectionOut = Type.Object({
    id: Type.String(),
    protocol: Type.String(),
    name: Type.String(),
    enabled: Type.Boolean(),
    jitProvisioning: Type.Boolean(),
    createdAt: Type.String(),
    /** OIDC issuer or SAML IdP sign-in URL (never the client secret or certificate). */
    idpUrl: Type.Union([Type.String(), Type.Null()]),
    clientId: Type.Union([Type.String(), Type.Null()]),
    hasClientSecret: Type.Boolean(),
    acsUrl: Type.String(),
    redirectUri: Type.String(),
    spEntityId: Type.String(),
    /** Starts a real sign-in with this connection (for testing it before enforcing SSO). */
    testSignInUrl: Type.String(),
  });
  type ConnRow = { id: string; protocol: 'oidc' | 'saml'; name: string; enabled: boolean; jit_provisioning: boolean; created_at: string; config: Partial<OidcConfig & SamlConfig> };
  const connectionOut = (tenantId: string, slug: string, r: ConnRow) => ({
    id: r.id,
    protocol: r.protocol,
    name: r.name,
    enabled: r.enabled,
    jitProvisioning: r.jit_provisioning,
    createdAt: r.created_at,
    idpUrl: (r.protocol === 'oidc' ? r.config.issuer : r.config.entryPoint) ?? null,
    clientId: r.protocol === 'oidc' ? (r.config.clientId ?? null) : null,
    hasClientSecret: !!r.config.clientSecretEnc,
    acsUrl: samlAcs,
    redirectUri: oidcCallback,
    spEntityId: spEntityId(tenantId, r.id),
    testSignInUrl: `${api}/v1/auth/sso/start?tenant=${encodeURIComponent(slug)}&connection=${r.id}`,
  });
  const tenantSlug = async (tx: Tx) => (await tx.one<{ slug: string }>('SELECT slug FROM app.tenants')).slug;
  const CONN_COLUMNS = 'id, protocol, name, enabled, jit_provisioning, created_at, config';

  app.get('/v1/settings/sso-connections', { schema: { tags: ['settings'], response: { 200: Type.Array(ConnectionOut), 403: Problem } } }, async (req) => {
    const auth = authorize(req, 'settings.read');
    return app.tenantTx(
      req,
      async (tx) => {
        const slug = await tenantSlug(tx);
        return (await tx.query<ConnRow>(`SELECT ${CONN_COLUMNS} FROM app.sso_connections ORDER BY created_at`)).map((r) => connectionOut(auth.tenantId, slug, r));
      },
      { readOnly: true },
    );
  });

  /** Refuses a change that would leave SSO enforced with no enabled connection (everyone would be locked out). */
  async function assertNotLastEnforced(tx: Tx, id: string) {
    const security = await loadSecurity(tx);
    if (!security.ssoEnforced) return;
    const others = await tx.maybe('SELECT 1 FROM app.sso_connections WHERE enabled AND id <> $1', [id]);
    if (!others) throw new ApiError('unprocessable', 'Stop enforcing SSO before turning off or removing the last enabled connection');
  }

  app.patch(
    '/v1/settings/sso-connections/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), enabled: Type.Optional(Type.Boolean()), jitProvisioning: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
        response: { 200: ConnectionOut, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { name?: string; enabled?: boolean; jitProvisioning?: boolean };
      return app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<ConnRow>(`SELECT ${CONN_COLUMNS} FROM app.sso_connections WHERE id = $1 FOR UPDATE`, [id]);
        if (!before) throw new ApiError('notFound');
        if (b.enabled === false && before.enabled) await assertNotLastEnforced(tx, id);
        const row = await tx.one<ConnRow>(
          `UPDATE app.sso_connections SET name = coalesce($2, name), enabled = coalesce($3, enabled), jit_provisioning = coalesce($4, jit_provisioning), updated_at = now()
            WHERE id = $1 RETURNING ${CONN_COLUMNS}`,
          [id, b.name ?? null, b.enabled ?? null, b.jitProvisioning ?? null],
        );
        await app.audit(tx, req, {
          action: 'sso.connection_updated',
          targetType: 'sso_connection',
          targetId: id,
          diff: { before: { name: before.name, enabled: before.enabled, jitProvisioning: before.jit_provisioning }, after: { name: row.name, enabled: row.enabled, jitProvisioning: row.jit_provisioning } },
        });
        return connectionOut(auth.tenantId, await tenantSlug(tx), row);
      });
    },
  );

  app.delete(
    '/v1/settings/sso-connections/:id',
    { config: { selfAudited: true }, schema: { tags: ['settings'], params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null(), 403: Problem, 404: Problem, 422: Problem } } },
    async (req, reply) => {
      authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const row = await tx.maybe<{ name: string; protocol: string; enabled: boolean }>('SELECT name, protocol, enabled FROM app.sso_connections WHERE id = $1 FOR UPDATE', [id]);
        if (!row) throw new ApiError('notFound');
        if (row.enabled) await assertNotLastEnforced(tx, id);
        await tx.exec('DELETE FROM app.sso_connections WHERE id = $1', [id]);
        await app.audit(tx, req, { action: 'sso.connection_deleted', targetType: 'sso_connection', targetId: id, diff: { name: row.name, protocol: row.protocol } });
      });
      return reply.status(204).send(null);
    },
  );
}
