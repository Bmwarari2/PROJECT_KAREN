import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { REGIONS, type HomeRegion } from '@thapsus/core';
import { enqueueJob, withRegistry, withTenant, writeAudit, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { requireFeature } from '../../lib/features';
import { SlugTakenError } from '../../lib/directory';
import { DEPARTMENTS, isoDate, JOB_TITLES, prng, syntheticPersonName } from '../../cli/fixtures';
import { composeToken, hashToken, newToken } from '../auth/tokens';
import { MAGIC_PREFIX } from '../auth/routes';
import { assignRole, seedBuiltInRoles } from '../authz/principal';
import { registerJob } from '../../jobs/registry';
import { platformConfig } from './config';
import { CONFIG_TABLES, scrubPersonRefs } from './sandbox-tables';

/**
 * Sandbox tenants (brief §6.10, ADR-0096): a new tenant in the SAME home region, created from the
 * production tenant's CONFIGURATION ONLY (the allow-list in sandbox-tables.ts) with synthetic people.
 * No personal data is copied: people, users, documents, absences, audit history, credentials and
 * integrations are never read into the sandbox. Synthetic names come from the fixtures generator and
 * skip any candidate that collides with a name in the source, so no name, email or identifier overlaps.
 * Admins open a sandbox with a one-time sign-in link for its synthetic owner account.
 */
export const Sandbox = Type.Object({
  id: Uuid,
  sandboxTenantId: Uuid,
  slug: Type.String(),
  name: Type.String(),
  syntheticPeople: Type.Integer(),
  status: Type.Union([Type.Literal('creating'), Type.Literal('ready'), Type.Literal('failed')]),
  report: Nullable(
    Type.Object({ copied: Type.Record(Type.String(), Type.Integer()), syntheticPeople: Type.Integer() }),
  ),
  error: Nullable(Type.String()),
  createdAt: Type.String(),
  readyAt: Nullable(Type.String()),
});
interface SandboxRow {
  id: string;
  sandbox_tenant_id: string;
  slug: string;
  name: string;
  synthetic_people: number;
  status: 'creating' | 'ready' | 'failed';
  report: { copied: Record<string, number>; syntheticPeople: number } | null;
  error: string | null;
  created_at: string;
  ready_at: string | null;
}
const sandboxOut = (r: SandboxRow) => ({
  id: r.id,
  sandboxTenantId: r.sandbox_tenant_id,
  slug: r.slug,
  name: r.name,
  syntheticPeople: r.synthetic_people,
  status: r.status,
  report: r.report,
  error: r.error,
  createdAt: r.created_at,
  readyAt: r.ready_at,
});

export const sandboxOwnerEmail = (slug: string) => `owner@${slug}.sandbox.example`;

async function insertableColumns(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx.query<{ c: string }>(
    `SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
    [table],
  );
  return rows.map((r) => r.c);
}

/** Reads the configuration of the source tenant (read-only transaction) — config tables only. */
async function readSourceConfig(deps: Deps, sourceTenantId: string) {
  return withTenant(
    deps.router,
    sourceTenantId,
    async (tx) => {
      const tables: Record<string, Array<Record<string, unknown>>> = {};
      for (const table of CONFIG_TABLES) {
        if (table === 'app.tenants') continue;
        const where = table === 'app.roles' ? 'WHERE NOT t.built_in' : '';
        tables[table] = (
          await tx.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) AS row FROM ${table} t ${where}`,
          )
        ).map((r) => r.row);
      }
      const tenant = await tx.one<{
        name: string;
        home_region: HomeRegion;
        default_locale: string;
        default_currency: string;
        default_time_zone: string;
        security: Record<string, unknown>;
        security_defaults_version: number;
        branding: Record<string, unknown>;
        features: Record<string, unknown>;
        kind: string;
      }>(
        'SELECT name, home_region, default_locale, default_currency, default_time_zone, security, security_defaults_version, branding, features, kind FROM app.tenants',
      );
      // Names and identifiers of source people are read ONLY to avoid collisions; they are never written.
      const taken = await tx.query<{ v: string }>(
        `SELECT lower(legal_first_name) AS v FROM app.employee_personal UNION SELECT lower(legal_last_name) FROM app.employee_personal
         UNION SELECT lower(preferred_name) FROM app.employee_personal WHERE preferred_name IS NOT NULL
         UNION SELECT lower(display_name) FROM app.employees UNION SELECT lower(employee_number) FROM app.employees
         UNION SELECT lower(display_name) FROM app.users UNION SELECT lower(split_part(display_name, ' ', 1)) FROM app.employees
         UNION SELECT lower(split_part(display_name, ' ', 2)) FROM app.employees`,
      );
      return { tables, tenant, taken: new Set(taken.map((t) => t.v).filter(Boolean)) };
    },
    { readOnly: true },
  );
}

/** Creates the sandbox's data in ONE transaction in the sandbox tenant (idempotent: skipped when done). */
export async function buildSandbox(deps: Deps, sourceTenantId: string, sb: SandboxRow) {
  const src = await readSourceConfig(deps, sourceTenantId);
  const r = prng(parseInt(sb.sandbox_tenant_id.slice(0, 8), 16));
  return withTenant(deps.router, sb.sandbox_tenant_id, async (tx) => {
    if (await tx.maybe('SELECT 1 FROM app.tenants')) return undefined; // already built
    const spec = REGIONS[src.tenant.home_region];
    const flags = { ...((src.tenant.features.flags as Record<string, boolean>) ?? {}), sandboxes: false };
    const branding = { ...src.tenant.branding } as Record<string, unknown> & {
      logo?: { key: string; contentType: string };
    };
    if (branding.logo?.key) {
      try {
        const key = `${sb.sandbox_tenant_id}/branding/logo-${crypto.randomUUID()}`;
        await deps.objects.put(key, await deps.objects.get(branding.logo.key), branding.logo.contentType);
        branding.logo = { ...branding.logo, key };
      } catch {
        delete branding.logo;
      }
    }
    await tx.exec(
      `INSERT INTO app.tenants (tenant_id, slug, name, home_region, kind, default_locale, default_currency, default_time_zone, security, security_defaults_version, branding, features)
       VALUES (app.current_tenant(), $1, $2, $3, 'sandbox', $4, $5, $6, $7, $10, $8, $9)`,
      [
        sb.slug,
        sb.name,
        src.tenant.home_region,
        src.tenant.default_locale ?? spec.defaultLocale,
        src.tenant.default_currency ?? spec.defaultCurrency,
        src.tenant.default_time_zone ?? spec.defaultTimeZone,
        // production SSO connections are not copied, so SSO cannot be enforced in the sandbox
        JSON.stringify({ ...src.tenant.security, ssoEnforced: false }),
        JSON.stringify(branding),
        JSON.stringify({ flags, plan: 'sandbox', sandbox: { sourceTenantId } }),
        // the sandbox keeps the source's sign-in policy defaults (ADR-0170)
        src.tenant.security_defaults_version,
      ],
    );
    await seedBuiltInRoles(tx);
    const copied: Record<string, number> = { 'app.tenants': 1 };
    for (const table of CONFIG_TABLES) {
      if (table === 'app.tenants') continue;
      const rows = (src.tables[table] ?? []).map((row) => ({
        ...(scrubPersonRefs(row) as Record<string, unknown>),
        tenant_id: sb.sandbox_tenant_id,
      }));
      copied[table] = rows.length;
      if (!rows.length) continue;
      const cols = (await insertableColumns(tx, table)).map((c) => `"${c}"`).join(', ');
      await tx.exec(
        `INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
        [JSON.stringify(rows)],
      );
    }

    // ---- synthetic people --------------------------------------------------------------------------
    let entities = await tx.query<{ id: string; currency: string }>(
      'SELECT id, currency FROM app.legal_entities ORDER BY created_at, id',
    );
    if (!entities.length) {
      entities = [
        await tx.one<{ id: string; currency: string }>(
          `INSERT INTO app.legal_entities (tenant_id, name, country, currency, time_zone) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id, currency`,
          [
            `${sb.name} entity`,
            spec.code === 'us' ? 'US' : spec.code === 'eu' ? 'DE' : 'GB',
            spec.defaultCurrency,
            spec.defaultTimeZone,
          ],
        ),
      ];
    }
    const locations = await tx.query<{ id: string; entity_id: string | null }>(
      'SELECT id, entity_id FROM app.locations ORDER BY id',
    );
    const departments = await tx.query<{ id: string }>('SELECT id FROM app.departments ORDER BY id');
    if (!departments.length) {
      for (const d of DEPARTMENTS.slice(0, 4))
        departments.push(
          await tx.one<{ id: string }>(
            'INSERT INTO app.departments (tenant_id, name) VALUES (app.current_tenant(), $1) RETURNING id',
            [d],
          ),
        );
    }
    const people: string[] = [];
    const used = new Set<string>();
    for (let i = 0; people.length < sb.synthetic_people && i < sb.synthetic_people * 50; i++) {
      const { first, last } = syntheticPersonName(r);
      const display = `${first} ${last}`;
      if (
        src.taken.has(first.toLowerCase()) ||
        src.taken.has(last.toLowerCase()) ||
        src.taken.has(display.toLowerCase()) ||
        used.has(display)
      )
        continue;
      used.add(display);
      const n = people.length + 1;
      let number = `SBX${String(n).padStart(5, '0')}`;
      if (src.taken.has(number.toLowerCase())) number = `SBX-${newToken(6)}`;
      const entity = entities[n % entities.length]!;
      const location = locations.find((l) => l.entity_id === entity.id) ?? locations[0];
      const start = isoDate(
        new Date(Date.UTC(2018 + Math.floor(r() * 7), Math.floor(r() * 12), 1 + Math.floor(r() * 27))),
      );
      const e = await tx.one<{ id: string }>(
        `INSERT INTO app.employees (tenant_id, employee_number, start_date, work_email, display_name) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
        [number, start, `${first}.${last}.${n}@${sb.slug}.sandbox.example`.toLowerCase(), display],
      );
      await tx.exec(
        `INSERT INTO app.employee_personal (tenant_id, employee_id, valid_from, legal_first_name, legal_last_name) VALUES (app.current_tenant(), $1, $2, $3, $4)`,
        [e.id, start, first, last],
      );
      await tx.exec(
        `INSERT INTO app.employee_jobs (tenant_id, employee_id, valid_from, job_title, department_id, location_id, entity_id, weekly_hours, employment_type, fte)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 37.5, 'full_time', 1)`,
        [
          e.id,
          start,
          JOB_TITLES[Math.floor(r() * JOB_TITLES.length)],
          departments[n % departments.length]!.id,
          location?.id ?? null,
          entity.id,
        ],
      );
      await tx.exec(
        `INSERT INTO app.employee_pay (tenant_id, employee_id, valid_from, amount_minor, currency, frequency) VALUES (app.current_tenant(), $1, $2, $3, $4, 'annual')`,
        [e.id, start, (28_000 + Math.floor(r() * 50_000)) * 100, entity.currency],
      );
      await tx.exec(
        `INSERT INTO app.employee_contracts (tenant_id, employee_id, valid_from, contract_type, notice_period_days) VALUES (app.current_tenant(), $1, $2, 'permanent', 30)`,
        [e.id, start],
      );
      if (people.length)
        await tx.exec(
          `INSERT INTO app.reporting_lines (tenant_id, employee_id, manager_id, kind, valid_from) VALUES (app.current_tenant(), $1, $2, 'solid', $3)`,
          [e.id, people[Math.floor((people.length - 1) / 5)], start],
        );
      people.push(e.id);
    }
    await tx.query('SELECT app.refresh_employee_current(NULL)');
    const owner = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
      [sandboxOwnerEmail(sb.slug), 'Sandbox owner'],
    );
    await assignRole(tx, owner.id, 'owner', { type: 'all' });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'tenant.sandbox_created',
      targetType: 'tenant',
      targetId: sb.sandbox_tenant_id,
      diff: { sourceTenantId, copied, syntheticPeople: people.length },
    });
    return { copied, syntheticPeople: people.length };
  });
}

registerJob('sandbox.create', async (ctx) => {
  const sandboxId = String(ctx.job.input.sandboxId);
  const sb = await ctx.tx((tx) =>
    tx.maybe<SandboxRow>('SELECT * FROM app.sandboxes WHERE id = $1', [sandboxId]),
  );
  if (!sb || sb.status === 'ready') return { skipped: true };
  try {
    const report = (await buildSandbox(ctx.deps, ctx.tenantId, sb)) ??
      sb.report ?? { copied: {}, syntheticPeople: 0 };
    await ctx.tx(async (tx) => {
      await tx.exec(
        `UPDATE app.sandboxes SET status = 'ready', report = $2, ready_at = now(), error = NULL WHERE id = $1`,
        [sandboxId, JSON.stringify(report)],
      );
      await writeAudit(tx, {
        actorType: 'system',
        action: 'sandbox.ready',
        targetType: 'sandbox',
        targetId: sandboxId,
        diff: report,
      });
    });
    return report;
  } catch (err) {
    await ctx.tx((tx) =>
      tx.exec(`UPDATE app.sandboxes SET status = 'failed', error = $2 WHERE id = $1`, [
        sandboxId,
        (err as Error).message.slice(0, 300),
      ]),
    );
    throw err;
  }
});

export async function sandboxRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.get(
    '/v1/sandboxes',
    {
      schema: {
        tags: ['sandboxes'],
        summary: 'Sandboxes created from this workspace',
        response: { 200: Type.Array(Sandbox), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const rows = await app.tenantTx(
        req,
        (tx) => tx.query<SandboxRow>('SELECT * FROM app.sandboxes ORDER BY created_at DESC'),
        { readOnly: true },
      );
      return rows.map(sandboxOut);
    },
  );

  app.get(
    '/v1/sandboxes/:id',
    {
      schema: {
        tags: ['sandboxes'],
        params: Type.Object({ id: Uuid }),
        response: { 200: Sandbox, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const row = await app.tenantTx(
        req,
        (tx) =>
          tx.maybe<SandboxRow>('SELECT * FROM app.sandboxes WHERE id = $1', [
            (req.params as { id: string }).id,
          ]),
        { readOnly: true },
      );
      if (!row) throw new ApiError('notFound');
      return sandboxOut(row);
    },
  );

  app.post(
    '/v1/sandboxes',
    {
      config: { selfAudited: true, capability: 'settings.sandbox' },
      schema: {
        tags: ['sandboxes'],
        summary:
          'Create a sandbox from this workspace’s configuration with synthetic people (no personal data is copied)',
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            syntheticPeople: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
          },
          { additionalProperties: false },
        ),
        response: { 202: Sandbox, 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const b = (req.body ?? {}) as { name?: string; syntheticPeople?: number };
      const source = await app.tenantTx(req, async (tx) => {
        await requireFeature(tx, 'sandboxes');
        const t = await tx.one<{ slug: string; name: string; kind: string; home_region: HomeRegion }>(
          'SELECT slug, name, kind, home_region FROM app.tenants',
        );
        if (t.kind !== 'production') throw new ApiError('unprocessable', 'sandboxOfSandbox');
        const n = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.sandboxes WHERE status <> 'failed'`,
        );
        if (n.n >= platformConfig.sandboxes.maxPerTenant)
          throw new ApiError('conflict', 'sandboxLimitReached', {
            limit: platformConfig.sandboxes.maxPerTenant,
          });
        return t;
      });
      // Residency: a sandbox lives in the same cell and home region as its source.
      const sandboxTenantId = crypto.randomUUID();
      let slug = '';
      for (let i = 0; i < 5 && !slug; i++) {
        const candidate = `${source.slug.slice(0, 28).replace(/-+$/, '')}-sbx-${newToken(6)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '0')
          .slice(0, 4)}`;
        try {
          await deps.directory.register({
            tenantId: sandboxTenantId,
            slug: candidate,
            homeRegion: source.home_region,
            status: 'active',
            planRef: 'sandbox',
            verifiedDomains: [],
          });
          slug = candidate;
        } catch (err) {
          if (!(err instanceof SlugTakenError)) throw err;
        }
      }
      if (!slug) throw new ApiError('conflict');
      await withRegistry(deps.router, (tx) =>
        tx.exec('INSERT INTO registry.tenants (tenant_id, slug, home_region) VALUES ($1, $2, $3)', [
          sandboxTenantId,
          slug,
          source.home_region,
        ]),
      );
      deps.router.invalidate(sandboxTenantId);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<SandboxRow>(
          `INSERT INTO app.sandboxes (tenant_id, sandbox_tenant_id, slug, name, synthetic_people, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING *`,
          [
            sandboxTenantId,
            slug,
            b.name ?? `${source.name} (sandbox)`,
            b.syntheticPeople ?? platformConfig.sandboxes.defaultSyntheticPeople,
            auth.userId,
          ],
        );
        const job = await enqueueJob(
          tx,
          'sandbox.create',
          r.id,
          { sandboxId: r.id },
          { createdBy: auth.userId },
        );
        await tx.exec('UPDATE app.sandboxes SET job_id = $2 WHERE id = $1', [r.id, job.id]);
        await app.audit(tx, req, {
          action: 'sandbox.created',
          targetType: 'sandbox',
          targetId: r.id,
          diff: { sandboxTenantId, slug, syntheticPeople: r.synthetic_people },
        });
        return { ...r, job_id: job.id };
      });
      return reply.status(202).send(sandboxOut(row));
    },
  );

  app.post(
    '/v1/sandboxes/:id/sign-in-link',
    {
      config: { selfAudited: true, capability: 'settings.sandbox' },
      schema: {
        tags: ['sandboxes'],
        summary: 'One-time sign-in link (15 minutes) for the sandbox’s synthetic owner account',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ url: Type.String(), expiresAt: Type.String(), email: Type.String() }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      const sb = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<SandboxRow>('SELECT * FROM app.sandboxes WHERE id = $1', [id]);
        if (!r) throw new ApiError('notFound');
        if (r.status !== 'ready') throw new ApiError('conflict', 'sandboxNotReady');
        await app.audit(tx, req, {
          action: 'sandbox.sign_in_link_issued',
          targetType: 'sandbox',
          targetId: id,
        });
        return r;
      });
      const secret = newToken();
      const expires = new Date(deps.now().getTime() + 15 * 60_000);
      await withTenant(deps.router, sb.sandbox_tenant_id, async (tx) => {
        const owner = await tx.one<{ id: string }>('SELECT id FROM app.users WHERE email = $1', [
          sandboxOwnerEmail(sb.slug),
        ]);
        await tx.exec(
          'INSERT INTO app.magic_links (tenant_id, user_id, token_hash, expires_at) VALUES (app.current_tenant(), $1, $2, $3)',
          [owner.id, hashToken(secret), expires],
        );
        await writeAudit(tx, {
          actorType: 'system',
          action: 'auth.sandbox_link_issued',
          targetType: 'user',
          targetId: owner.id,
          diff: { fromTenant: req.auth!.tenantId, by: req.auth!.userId },
          requestId: req.id,
        });
      });
      const token = composeToken(MAGIC_PREFIX, sb.sandbox_tenant_id, secret);
      return {
        url: `${deps.config.appBaseUrl}/auth/magic?token=${encodeURIComponent(token)}`,
        expiresAt: expires.toISOString(),
        email: sandboxOwnerEmail(sb.slug),
      };
    },
  );
}
