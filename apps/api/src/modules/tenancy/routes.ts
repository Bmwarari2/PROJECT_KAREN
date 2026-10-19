import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { REGIONS, isHomeRegion, type HomeRegion } from '@thapsus/core';
import { t, isLocale } from '@thapsus/core/i18n';
import { TRUST, templateForRegion } from '@thapsus/core/trust';
import { withRegistry, withTenant, writeAudit } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { authorize } from '../../http/context';
import { hashPassword, passwordProblems } from '../auth/tokens';
import { startSession, throttle } from '../auth/common';
import { assignRole, seedBuiltInRoles } from '../authz/principal';
import { SlugTakenError } from '../../lib/directory';

export const SLUG_RE = '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$';
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'status', 'help', 'global', 'mail', 'support', 'backoffice', 'thapsus']);

export async function tenancyRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.post(
    '/v1/signup',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['tenancy'],
        summary: 'Create a workspace in this region (the caller has already chosen the home region)',
        body: Type.Object({
          companyName: Type.String({ minLength: 2, maxLength: 120 }),
          slug: Type.String({ pattern: SLUG_RE }),
          region: Type.Union([Type.Literal('uk'), Type.Literal('eu'), Type.Literal('us')]),
          ownerName: Type.String({ minLength: 1, maxLength: 120 }),
          ownerEmail: Type.String({ format: 'email', maxLength: 254 }),
          password: Type.String({ minLength: 12, maxLength: 128 }),
          locale: Type.Optional(Type.String()),
          acceptDpa: Type.Literal(true),
        }),
        response: { 201: Type.Object({ tenantId: Type.String(), userId: Type.String(), slug: Type.String(), region: Type.String() }), 400: Problem, 409: Problem, 421: Problem, 429: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { companyName: string; slug: string; region: HomeRegion; ownerName: string; ownerEmail: string; password: string; locale?: string };
      await throttle(deps, [[`signup:ip:${req.ctx.ip}`, 10, 3600]]);
      if (b.region !== deps.config.cell) {
        throw new ApiError('wrongRegion', undefined, { region: b.region, appUrl: deps.regionalAppUrls[b.region] });
      }
      if (RESERVED.has(b.slug)) throw new ApiError('conflict');
      const problems = passwordProblems(b.password);
      if (problems.length) throw new ApiError('validation', undefined, { errors: problems.map((p) => ({ path: '/password', message: p })) });
      const spec = REGIONS[b.region];
      const tenantId = crypto.randomUUID();
      try {
        await deps.directory.register({ tenantId, slug: b.slug, homeRegion: b.region, status: 'active', planRef: 'trial', verifiedDomains: [] });
      } catch (err) {
        if (err instanceof SlugTakenError) throw new ApiError('conflict');
        throw err;
      }
      const passwordHash = await hashPassword(b.password);
      await withRegistry(deps.router, (tx) =>
        tx.exec('INSERT INTO registry.tenants (tenant_id, slug, home_region) VALUES ($1, $2, $3)', [tenantId, b.slug, b.region]),
      );
      deps.router.invalidate(tenantId);
      const userId = await withTenant(deps.router, tenantId, async (tx) => {
        const locale = isLocale(b.locale) ? b.locale : spec.defaultLocale;
        await tx.exec(
          `INSERT INTO app.tenants (tenant_id, slug, name, home_region, default_locale, default_currency, default_time_zone, features)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{"aiAssistant": false}')`,
          [tenantId, b.slug, b.companyName, b.region, locale, spec.defaultCurrency, spec.defaultTimeZone],
        );
        await seedBuiltInRoles(tx);
        const u = await tx.one<{ id: string }>(
          `INSERT INTO app.users (tenant_id, email, display_name, locale, time_zone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [tenantId, b.ownerEmail.toLowerCase(), b.ownerName, locale, spec.defaultTimeZone],
        );
        await tx.exec(`INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [tenantId, u.id, passwordHash]);
        await assignRole(tx, u.id, 'owner', { type: 'all' });
        await assignRole(tx, u.id, 'employee', { type: 'self' });
        // The DPA in force for the home region is accepted at sign-up; later versions must be re-accepted.
        const dpa = TRUST.dpa[templateForRegion(b.region)];
        await tx.exec(`INSERT INTO app.dpa_acceptances (tenant_id, dpa_version, template, accepted_by, accepted_by_name, ip, document_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tenantId, dpa.version, templateForRegion(b.region), u.id, b.ownerName, req.ctx.ip, dpa.sha256]);
        await writeAudit(tx, { actorType: 'user', actorId: u.id, action: 'tenant.created', targetType: 'tenant', targetId: tenantId, diff: { region: b.region, slug: b.slug, dpaAccepted: true, dpaVersion: dpa.version }, ip: req.ctx.ip, requestId: req.id });
        await tx.exec(
          `INSERT INTO app.outbox (tenant_id, topic, aggregate_type, aggregate_id, payload) VALUES ($1::uuid, 'tenant.created', 'tenant', $1::text, '{}')`,
          [tenantId],
        );
        await startSession(deps, req, reply, tx, { tenantId, userId: u.id, method: 'password', mfaVerified: false });
        return u.id;
      });
      return reply.status(201).send({ tenantId, userId, slug: b.slug, region: b.region });
    },
  );

  // ---- Region-aware sign-in support (regional side) --------------------------------------------
  app.post(
    '/v1/internal/find-workspace',
    { config: { auth: 'public', selfAudited: true }, schema: { hide: true, body: Type.Object({ email: Type.String({ format: 'email' }), locale: Type.Optional(Type.String()) }) } },
    async (req, reply) => {
      const expected = deps.config.internalToken;
      const got = String(req.headers['x-internal-token'] ?? '');
      if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new ApiError('forbidden');
      const { email, locale } = req.body as { email: string; locale?: string };
      const pool = deps.router.registryPool();
      const ids = (await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM app.tenants_for_email($1)', [email])).rows.map((r) => r.tenant_id);
      if (ids.length) {
        const slugs = (await pool.query<{ slug: string }>(`SELECT slug FROM registry.tenants WHERE tenant_id = ANY($1) AND status = 'active'`, [ids])).rows;
        const loc = isLocale(locale) ? locale : 'en-GB';
        const list = slugs.map((s) => `${deps.config.appBaseUrl}/signin?workspace=${s.slug}`).join('\n');
        // Sent from this region's mail service; the global layer never sees the address again.
        await deps.mailer.send({ to: email, subject: t(loc, 'auth.findWorkspaceSubject'), text: t(loc, 'auth.findWorkspaceBody', { list }) });
      }
      return reply.status(202).send(null);
    },
  );

  // ---- Verified domains ------------------------------------------------------------------------
  const DomainOut = Type.Object({ id: Type.String(), domain: Type.String(), txtName: Type.String(), txtValue: Type.String(), verifiedAt: Type.Union([Type.String(), Type.Null()]) });
  const toDomain = (r: { id: string; domain: string; verification_token: string; verified_at: string | null }) => ({
    id: r.id,
    domain: r.domain,
    txtName: `_thapsus-hr.${r.domain}`,
    txtValue: `thapsus-hr-verification=${r.verification_token}`,
    verifiedAt: r.verified_at,
  });

  app.get('/v1/settings/domains', { schema: { tags: ['settings'], response: { 200: Type.Array(DomainOut) } } }, async (req) => {
    authorize(req, 'settings.read');
    const rows = await app.tenantTx(req, (tx) => tx.query<{ id: string; domain: string; verification_token: string; verified_at: string | null }>('SELECT * FROM app.verified_domains ORDER BY domain'));
    return rows.map(toDomain);
  });

  app.post(
    '/v1/settings/domains',
    { config: { selfAudited: true }, schema: { tags: ['settings'], body: Type.Object({ domain: Type.String({ pattern: '^(?=.{4,253}$)([a-z0-9-]{1,63}\\.)+[a-z]{2,63}$' }) }), response: { 201: DomainOut, 403: Problem, 409: Problem } } },
    async (req, reply) => {
      authorize(req, 'settings.manage');
      const domain = (req.body as { domain: string }).domain.toLowerCase();
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string; domain: string; verification_token: string; verified_at: string | null }>(
          `INSERT INTO app.verified_domains (tenant_id, domain, verification_token) VALUES (app.current_tenant(), $1, $2) RETURNING *`,
          [domain, randomBytes(18).toString('hex')],
        );
        await app.audit(tx, req, { action: 'domain.added', targetType: 'domain', targetId: r.id, diff: { domain } });
        return r;
      });
      return reply.status(201).send(toDomain(row));
    },
  );

  app.post(
    '/v1/settings/domains/:id/verify',
    { config: { selfAudited: true }, schema: { tags: ['settings'], params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 200: DomainOut, 403: Problem, 404: Problem, 422: Problem } } },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      const row = await app.tenantTx(req, (tx) => tx.maybe<{ id: string; domain: string; verification_token: string; verified_at: string | null }>('SELECT * FROM app.verified_domains WHERE id = $1', [id]));
      if (!row) throw new ApiError('notFound');
      const expected = `thapsus-hr-verification=${row.verification_token}`;
      const records = await deps.dns.resolveTxt(`_thapsus-hr.${row.domain}`).catch(() => [] as string[][]);
      if (!records.some((chunks) => chunks.join('') === expected)) throw new ApiError('unprocessable', 'TXT record not found');
      const updated = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string; domain: string; verification_token: string; verified_at: string | null }>(
          'UPDATE app.verified_domains SET verified_at = coalesce(verified_at, now()) WHERE id = $1 RETURNING *',
          [id],
        );
        await app.audit(tx, req, { action: 'domain.verified', targetType: 'domain', targetId: id, diff: { domain: r.domain } });
        return r;
      });
      const all = await app.tenantTx(req, (tx) => tx.query<{ domain: string }>('SELECT domain FROM app.verified_domains WHERE verified_at IS NOT NULL'));
      await deps.directory.update(auth.tenantId, { verifiedDomains: all.map((d) => d.domain) });
      return toDomain(updated);
    },
  );
}

/** Global layer: slug/domain → region, and "find my workspace" fan-out. Holds no personal data. */
export async function globalRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.get(
    '/global/v1/resolve',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['global'],
        querystring: Type.Object({ slug: Type.Optional(Type.String()), domain: Type.Optional(Type.String()), email: Type.Optional(Type.String()) }),
        response: { 200: Type.Object({ region: Type.String(), appUrl: Type.String(), apiUrl: Type.String(), slug: Type.String() }), 404: Problem },
      },
    },
    async (req) => {
      const q = req.query as { slug?: string; domain?: string; email?: string };
      await throttle(deps, [[`resolve:ip:${req.ctx.ip}`, 120, 60]]);
      const domain = q.domain ?? q.email?.split('@')[1];
      const entry = q.slug ? await deps.directory.bySlug(q.slug.toLowerCase()) : domain ? await deps.directory.byDomain(domain.toLowerCase()) : undefined;
      if (!entry || entry.status === 'deleted' || !isHomeRegion(entry.homeRegion)) throw new ApiError('notFound');
      return { region: entry.homeRegion, appUrl: deps.regionalAppUrls[entry.homeRegion], apiUrl: deps.regionalApiUrls[entry.homeRegion], slug: entry.slug };
    },
  );

  app.post(
    '/global/v1/find-workspace',
    { config: { auth: 'public' }, schema: { tags: ['global'], body: Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }), locale: Type.Optional(Type.String()) }), response: { 202: Type.Null(), 429: Problem } } },
    async (req, reply) => {
      const { email, locale } = req.body as { email: string; locale?: string };
      await throttle(deps, [[`find:ip:${req.ctx.ip}`, 10, 900]]);
      // Fan out to every region; each region emails the user itself. Nothing is stored here.
      await Promise.allSettled(
        (Object.keys(REGIONS) as HomeRegion[]).map((r) =>
          deps.fetch(`${deps.regionalApiUrls[r]}/v1/internal/find-workspace`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-token': deps.config.internalToken },
            body: JSON.stringify({ email, locale }),
            signal: AbortSignal.timeout(5000),
          }),
        ),
      );
      return reply.status(202).send(null);
    },
  );
}
