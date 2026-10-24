import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import {
  BILLING_CURRENCIES,
  PRIORITIES,
  planById,
  validateContractPricing,
  type ContactChannel,
  type Priority,
} from '@thapsus/core/billing';
import { HOME_REGIONS, REGIONS } from '@thapsus/core';
import { addDays, compareDates, instantToDate } from '@thapsus/core/time';
import { rules, RULE_KEYS } from '@thapsus/rules';
import { withTenant, writeAudit, TenantNotFoundError } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { notify } from '../../lib/notify';
import { activateContract, endContract } from '../billing/contracts';
import {
  activeContract,
  billingConfig,
  contractPricing,
  recordUsage,
  syncCustomer,
  type ContractRow,
  type SubRow,
} from '../billing/service';
import { subJson } from '../billing/routes';
import { employeeAsOf } from '../employees/service';
import { withSupportAccess } from '../support/access';
import { deadlinesFor, slaView, syncQueueEntry, type TicketRow } from '../support/service';
import { threadJson, ThreadT, contactOverrides } from '../support/tickets';
import { backofficePool, requireStaff, staffAudit } from './auth';

/**
 * Thapsus back office for this cell (ADR-0106). Company-level metadata (tenants, usage aggregates,
 * plans, contracts, billing account structure, the support queue index) is visible to staff by role.
 * Ticket content is shown because the customer submitted it to support (ADR-0101). Any other tenant
 * personal data is reachable only through a customer-granted support grant (withSupportAccess), and
 * every such access lands in the tenant's audit log and the staff audit trail.
 */
export async function backofficeRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const staff = (...roles: Array<'support' | 'rules_editor' | 'billing'>) => ({
    config: { auth: 'public' as const, selfAudited: true },
    preHandler: requireStaff(app, roles),
  });
  const now = () => deps.now().toISOString();
  const today = () => instantToDate(now(), 'UTC');
  const meta = (req: FastifyRequest) => ({ ip: req.ctx.ip, requestId: req.id });

  async function assertCellTenant(tenantId: string) {
    try {
      return await deps.router.lookup(tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError) throw new ApiError('notFound');
      throw err;
    }
  }
  /** Writes to the tenant's own audit log as a Thapsus staff actor (support). */
  const tenantAudit = (
    tenantId: string,
    req: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string,
    diff?: unknown,
  ) =>
    withTenant(deps.router, tenantId, (tx) =>
      writeAudit(tx, {
        actorType: 'support',
        actorId: req.staff!.staffId,
        action,
        targetType,
        targetId,
        diff,
        ip: req.ctx.ip,
        requestId: req.id,
      }),
    );

  // ---- overview -------------------------------------------------------------------------------------
  app.get(
    '/v1/backoffice/overview',
    {
      ...staff('support', 'rules_editor', 'billing'),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({
            cell: Type.String(),
            awsRegion: Type.String(),
            tenants: Type.Integer(),
            openTickets: Type.Integer(),
            slaAtRisk: Type.Integer(),
            slaBreached: Type.Integer(),
            activeContracts: Type.Integer(),
            renewalsDue: Type.Integer(),
            activeIncidents: Type.Integer(),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const pool = backofficePool(app);
      const n = now();
      const [{ rows: t }, { rows: q }, { rows: c }, { rows: i }] = await Promise.all([
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM registry.tenants WHERE home_region = $1 AND status <> 'deleted'`,
          [deps.config.cell],
        ),
        pool.query<{ open: number; at_risk: number; breached: number }>(
          `SELECT count(*)::int AS open,
             count(*) FILTER (WHERE (first_responded_at IS NULL AND first_response_at_risk_at <= $1 AND first_response_due_at >= $1) OR (resolution_at_risk_at <= $1 AND resolution_due_at >= $1))::int AS at_risk,
             count(*) FILTER (WHERE (first_responded_at IS NULL AND first_response_due_at < $1) OR resolution_due_at < $1)::int AS breached
             FROM backoffice.support_queue WHERE status IN ('open', 'awaiting_customer')`,
          [n],
        ),
        pool.query<{ active: number; due: number }>(
          `SELECT count(*)::int AS active, count(*) FILTER (WHERE ends_on - renewal_notice_days <= $1::date)::int AS due FROM backoffice.contracts WHERE status = 'active'`,
          [today()],
        ),
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM backoffice.status_incidents WHERE resolved_at IS NULL AND kind = 'incident'`,
        ),
      ]);
      return {
        cell: deps.config.cell,
        awsRegion: REGIONS[deps.config.cell].awsRegion,
        tenants: t[0]!.n,
        openTickets: q[0]!.open,
        slaAtRisk: q[0]!.at_risk,
        slaBreached: q[0]!.breached,
        activeContracts: c[0]!.active,
        renewalsDue: c[0]!.due,
        activeIncidents: i[0]!.n,
      };
    },
  );

  // ---- tenants: this cell (cell database) and every region (global directory only) --------------------
  const UsageT = Type.Object({
    headcount: Type.Integer(),
    activeUsers: Type.Integer(),
    storageBytes: Type.Integer(),
    computedAt: Type.String(),
  });
  const CellTenantT = Type.Object({
    tenantId: Uuid,
    slug: Type.String(),
    region: Type.String(),
    status: Type.String(),
    dbKey: Type.String(),
    createdAt: Type.String(),
    planId: Nullable(Type.String()),
    billingStatus: Nullable(Type.String()),
    usage: Nullable(UsageT),
    contractReference: Nullable(Type.String()),
  });
  app.get(
    '/v1/backoffice/tenants',
    {
      ...staff('support', 'billing'),
      schema: {
        tags: ['backoffice'],
        summary: "This cell's customers with usage aggregates (counts and bytes only)",
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 60 })) }),
        response: { 200: Type.Array(CellTenantT), 401: Problem, 403: Problem },
      },
    },
    async (req) => {
      const q = (req.query as { q?: string }).q?.toLowerCase() ?? '';
      const { rows } = await backofficePool(app).query<{
        tenant_id: string;
        slug: string;
        home_region: string;
        status: string;
        db_key: string;
        created_at: string;
        headcount: number | null;
        active_users: number | null;
        storage_bytes: string | null;
        plan_id: string | null;
        billing_status: string | null;
        computed_at: string | null;
        reference: string | null;
      }>(
        `SELECT r.tenant_id, r.slug, r.home_region, r.status, r.db_key, r.created_at, u.headcount, u.active_users, u.storage_bytes, u.plan_id, u.billing_status, u.computed_at, c.reference
           FROM registry.tenants r LEFT JOIN backoffice.tenant_usage u ON u.subject_tenant_id = r.tenant_id
           LEFT JOIN backoffice.contracts c ON c.subject_tenant_id = r.tenant_id AND c.status = 'active'
          WHERE r.home_region = $1 AND ($2 = '' OR r.slug LIKE '%' || $2 || '%') ORDER BY r.slug LIMIT 500`,
        [deps.config.cell, q],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        slug: r.slug,
        region: r.home_region,
        status: r.status,
        dbKey: r.db_key,
        createdAt: r.created_at,
        planId: r.plan_id,
        billingStatus: r.billing_status,
        usage: r.computed_at
          ? {
              headcount: r.headcount ?? 0,
              activeUsers: r.active_users ?? 0,
              storageBytes: Number(r.storage_bytes ?? 0),
              computedAt: r.computed_at,
            }
          : null,
        contractReference: r.reference,
      }));
    },
  );

  app.get(
    '/v1/backoffice/tenants/all-regions',
    {
      ...staff('support', 'billing'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Every region, from the global tenant directory only (ids, slugs, regions, plan, status; no personal data)',
        response: {
          200: Type.Array(
            Type.Object({
              tenantId: Type.String(),
              slug: Type.String(),
              region: Type.String(),
              status: Type.String(),
              planRef: Nullable(Type.String()),
            }),
          ),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () =>
      (await deps.directory.list()).map((e) => ({
        tenantId: e.tenantId,
        slug: e.slug,
        region: e.homeRegion,
        status: e.status,
        planRef: e.planRef,
      })),
  );

  const AccountStructureT = Type.Object({
    id: Uuid,
    name: Type.String(),
    isDefault: Type.Boolean(),
    currency: Type.String(),
    collection: Type.String(),
    paymentTermsDays: Nullable(Type.Integer()),
    poNumber: Nullable(Type.String()),
    entityIds: Type.Array(Uuid),
    detailsComplete: Type.Boolean(),
    subscription: Nullable(Type.Any()),
  });
  app.get(
    '/v1/backoffice/tenants/:tenantId',
    {
      ...staff('support', 'billing'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Customer detail: company name, usage, billing structure (no billing contacts), contracts, and whether this staff member holds a support grant',
        params: Type.Object({ tenantId: Uuid }),
        response: {
          200: Type.Object({
            tenantId: Uuid,
            slug: Type.String(),
            name: Type.String(),
            region: Type.String(),
            status: Type.String(),
            createdAt: Type.String(),
            usage: Nullable(UsageT),
            entities: Type.Array(Type.Object({ id: Uuid, name: Type.String(), country: Type.String() })),
            billingAccounts: Type.Array(AccountStructureT),
            contracts: Type.Array(Type.Any()),
            grant: Nullable(Type.Object({ id: Uuid, accessLevel: Type.String(), expiresAt: Type.String() })),
          }),
          401: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const reg = await assertCellTenant(tenantId);
      const pool = backofficePool(app);
      const detail = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const t = await tx.one<{ name: string; created_at: string }>(
            'SELECT name, created_at FROM app.tenants',
          );
          const entities = await tx.query<{ id: string; name: string; country: string }>(
            'SELECT id, name, country FROM app.legal_entities ORDER BY name',
          );
          const accounts = await tx.query<{
            id: string;
            name: string;
            is_default: boolean;
            currency: string;
            collection: string;
            payment_terms_days: number | null;
            po_number: string | null;
            complete: boolean;
          }>(
            `SELECT a.id, a.name, a.is_default, a.currency, a.collection, a.payment_terms_days, a.po_number,
                (a.address ? 'line1' AND EXISTS (SELECT 1 FROM app.billing_contacts c WHERE c.tenant_id = a.tenant_id AND c.billing_account_id = a.id AND c.is_primary)) AS complete
               FROM app.billing_accounts a ORDER BY a.is_default DESC, a.name`,
          );
          const out = [];
          for (const a of accounts) {
            const entityIds = (
              await tx.query<{ entity_id: string }>(
                'SELECT entity_id FROM app.billing_account_entities WHERE billing_account_id = $1',
                [a.id],
              )
            ).map((r) => r.entity_id);
            const sub = await tx.maybe<SubRow>(
              `SELECT * FROM app.billing_subscriptions WHERE billing_account_id = $1 ORDER BY (status <> 'canceled') DESC, created_at DESC LIMIT 1`,
              [a.id],
            );
            out.push({
              id: a.id,
              name: a.name,
              isDefault: a.is_default,
              currency: a.currency,
              collection: a.collection,
              paymentTermsDays: a.payment_terms_days,
              poNumber: a.po_number,
              entityIds,
              detailsComplete: a.complete,
              subscription: sub ? subJson(sub) : null,
            });
          }
          return { t, entities, accounts: out };
        },
        { readOnly: true, actorId: req.staff!.staffId },
      );
      const usage = (
        await pool.query<{
          headcount: number;
          active_users: number;
          storage_bytes: string;
          computed_at: string;
        }>(
          'SELECT headcount, active_users, storage_bytes, computed_at FROM backoffice.tenant_usage WHERE subject_tenant_id = $1',
          [tenantId],
        )
      ).rows[0];
      const contracts = (
        await pool.query<ContractRow>(
          'SELECT * FROM backoffice.contracts WHERE subject_tenant_id = $1 ORDER BY created_at DESC',
          [tenantId],
        )
      ).rows.map(contractJson);
      const grant = (
        await pool.query<{ id: string; access_level: string; expires_at: string }>(
          `SELECT id, access_level, expires_at FROM app.support_grants WHERE tenant_id = $1 AND staff_id = $2 AND revoked_at IS NULL AND now() >= starts_at AND now() < expires_at ORDER BY expires_at DESC LIMIT 1`,
          [tenantId, req.staff!.staffId],
        )
      ).rows[0];
      await staffAudit(app, req, 'tenant.viewed', {}, tenantId);
      return {
        tenantId,
        slug: reg.slug,
        name: detail.t.name,
        region: reg.home_region,
        status: reg.status,
        createdAt: detail.t.created_at,
        usage: usage
          ? {
              headcount: usage.headcount,
              activeUsers: usage.active_users,
              storageBytes: Number(usage.storage_bytes),
              computedAt: usage.computed_at,
            }
          : null,
        entities: detail.entities,
        billingAccounts: detail.accounts,
        contracts,
        grant: grant ? { id: grant.id, accessLevel: grant.access_level, expiresAt: grant.expires_at } : null,
      };
    },
  );

  app.post(
    '/v1/backoffice/tenants/:tenantId/usage/refresh',
    {
      ...staff('support', 'billing'),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ tenantId: Uuid }),
        response: { 200: UsageT, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      await assertCellTenant(tenantId);
      const at = now();
      const u = await withTenant(deps.router, tenantId, (tx) => recordUsage(deps, tenantId, tx, at));
      await staffAudit(app, req, 'tenant.usage_refreshed', {}, tenantId);
      return {
        headcount: u.headcount,
        activeUsers: u.active_users,
        storageBytes: Number(u.storage_bytes),
        computedAt: at,
      };
    },
  );

  // ---- multi-entity billing accounts (structure only; contacts are entered by the customer) ----------
  const AccountBody = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    currency: Type.Union(BILLING_CURRENCIES.map((c) => Type.Literal(c))),
    entityIds: Type.Array(Uuid, { maxItems: 100, uniqueItems: true }),
    collection: Type.Union([Type.Literal('charge_automatically'), Type.Literal('send_invoice')]),
    paymentTermsDays: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 120 }))),
    poNumber: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  });
  async function setEntities(tx: import('@thapsus/db').Tx, accountId: string, entityIds: string[]) {
    const known = await tx.query<{ id: string }>(
      'SELECT id FROM app.legal_entities WHERE id = ANY($1::uuid[])',
      [entityIds],
    );
    if (known.length !== entityIds.length) throw new ApiError('validation', 'Unknown legal entity');
    await tx.exec('DELETE FROM app.billing_account_entities WHERE billing_account_id = $1', [accountId]);
    // An entity moves to this account from any other account (each entity is billed once).
    for (const e of entityIds)
      await tx.exec(
        'INSERT INTO app.billing_account_entities (tenant_id, entity_id, billing_account_id) VALUES (app.current_tenant(), $1, $2) ON CONFLICT (tenant_id, entity_id) DO UPDATE SET billing_account_id = EXCLUDED.billing_account_id',
        [e, accountId],
      );
  }
  app.post(
    '/v1/backoffice/tenants/:tenantId/billing-accounts',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        summary: 'Group legal entities into a separately invoiced billing account (multi-entity billing)',
        params: Type.Object({ tenantId: Uuid }),
        body: AccountBody,
        response: { 201: Type.Object({ id: Uuid }), 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const b = req.body as Static<typeof AccountBody>;
      await assertCellTenant(tenantId);
      if (b.collection === 'send_invoice' && !b.paymentTermsDays)
        throw new ApiError('validation', 'Invoice collection needs payment terms');
      const id = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const a = await tx.one<{ id: string }>(
            `INSERT INTO app.billing_accounts (tenant_id, name, currency, collection, payment_terms_days, po_number) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
            [b.name, b.currency, b.collection, b.paymentTermsDays ?? null, b.poNumber ?? null],
          );
          await setEntities(tx, a.id, b.entityIds);
          await writeAudit(tx, {
            actorType: 'support',
            actorId: req.staff!.staffId,
            action: 'billing.account_created',
            targetType: 'billing_account',
            targetId: a.id,
            diff: {
              name: b.name,
              currency: b.currency,
              entities: b.entityIds.length,
              collection: b.collection,
            },
            ip: req.ctx.ip,
            requestId: req.id,
          });
          return a.id;
        },
        { actorId: req.staff!.staffId },
      );
      await staffAudit(
        app,
        req,
        'billing.account_created',
        { accountId: id, entities: b.entityIds.length },
        tenantId,
      );
      return reply.status(201).send({ id });
    },
  );

  app.patch(
    '/v1/backoffice/tenants/:tenantId/billing-accounts/:id',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Change a billing account: entities, currency, invoicing, payment terms, purchase order number',
        params: Type.Object({ tenantId: Uuid, id: Uuid }),
        body: Type.Partial(AccountBody),
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const b = req.body as Partial<Static<typeof AccountBody>>;
      await assertCellTenant(tenantId);
      const hasCustomer = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const cur = await tx.maybe<{
            provider_customer_id: string | null;
            collection: string;
            payment_terms_days: number | null;
            currency: string;
          }>(
            'SELECT provider_customer_id, collection, payment_terms_days, currency FROM app.billing_accounts WHERE id = $1',
            [id],
          );
          if (!cur) throw new ApiError('notFound');
          const collection = b.collection ?? cur.collection;
          const terms = b.paymentTermsDays !== undefined ? b.paymentTermsDays : cur.payment_terms_days;
          if (collection === 'send_invoice' && !terms)
            throw new ApiError('validation', 'Invoice collection needs payment terms');
          if (b.currency && b.currency !== cur.currency && cur.provider_customer_id)
            throw new ApiError(
              'conflict',
              'The currency of an account that has been billed cannot change; create a new account',
            );
          await tx.exec(
            `UPDATE app.billing_accounts SET name = coalesce($2, name), currency = coalesce($3, currency), collection = $4, payment_terms_days = $5, po_number = CASE WHEN $6 THEN $7 ELSE po_number END WHERE id = $1`,
            [
              id,
              b.name ?? null,
              b.currency ?? null,
              collection,
              terms,
              b.poNumber !== undefined,
              b.poNumber ?? null,
            ],
          );
          if (b.entityIds) await setEntities(tx, id, b.entityIds);
          await writeAudit(tx, {
            actorType: 'support',
            actorId: req.staff!.staffId,
            action: 'billing.account_updated',
            targetType: 'billing_account',
            targetId: id,
            diff: { changed: Object.keys(b) },
            ip: req.ctx.ip,
            requestId: req.id,
          });
          return !!cur.provider_customer_id;
        },
        { actorId: req.staff!.staffId },
      );
      // A new PO number must appear on the next invoices: refresh the provider customer.
      if (hasCustomer && b.poNumber !== undefined) await syncCustomer(deps, tenantId, id);
      await staffAudit(
        app,
        req,
        'billing.account_updated',
        { accountId: id, changed: Object.keys(b) },
        tenantId,
      );
      return reply.status(204).send(null);
    },
  );

  // ---- plans (from config) and enterprise contracts (back-office records) ---------------------------
  app.get(
    '/v1/backoffice/plans',
    {
      ...staff('billing', 'support'),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({
            location: Type.String(),
            version: Type.Integer(),
            effectiveFrom: Type.String(),
            plans: Type.Array(Type.Any()),
            terms: Type.Any(),
            discounts: Type.Any(),
            trialDays: Type.Integer(),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const cfg = billingConfig();
      return {
        location: process.env.BILLING_CONFIG_LOCATION ?? 'builtin:billing-config-v1',
        version: cfg.version,
        effectiveFrom: cfg.effectiveFrom,
        plans: cfg.plans,
        terms: cfg.terms,
        discounts: cfg.discounts,
        trialDays: cfg.trial.days,
      };
    },
  );

  function contractJson(c: ContractRow) {
    return {
      id: c.id,
      tenantId: c.subject_tenant_id,
      reference: c.reference,
      status: c.status,
      planId: c.plan_id,
      currency: c.currency,
      term: c.term,
      startsOn: c.starts_on,
      endsOn: c.ends_on,
      renewal: c.renewal,
      renewalNoticeDays: c.renewal_notice_days,
      renewalDue:
        c.status === 'active' && compareDates(addDays(c.ends_on, -c.renewal_notice_days), today()) <= 0,
      collection: c.collection,
      paymentTermsDays: c.payment_terms_days,
      pricing: c.pricing,
      notes: c.notes,
      activatedAt: c.activated_at,
    };
  }
  const Pricing = Type.Object({
    unitAmountMinor: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    flatAmountMinor: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    discountBasisPoints: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 9999 }))),
    minimumEmployees: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
  });
  const ContractBody = Type.Object({
    tenantId: Uuid,
    reference: Type.String({ minLength: 3, maxLength: 60 }),
    planId: Type.String({ maxLength: 40 }),
    currency: Type.Union(BILLING_CURRENCIES.map((c) => Type.Literal(c))),
    term: Type.Union([Type.Literal('monthly'), Type.Literal('annual')]),
    startsOn: Type.String({ format: 'date' }),
    endsOn: Type.String({ format: 'date' }),
    renewal: Type.Union([Type.Literal('auto'), Type.Literal('manual'), Type.Literal('none')]),
    renewalNoticeDays: Type.Integer({ minimum: 0, maximum: 365 }),
    collection: Type.Union([Type.Literal('charge_automatically'), Type.Literal('send_invoice')]),
    paymentTermsDays: Type.Integer({ minimum: 1, maximum: 120 }),
    pricing: Pricing,
    notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  });
  const ContractT = Type.Any();

  app.get(
    '/v1/backoffice/contracts',
    {
      ...staff('billing'),
      schema: { tags: ['backoffice'], response: { 200: Type.Array(ContractT), 401: Problem, 403: Problem } },
    },
    async () => {
      const { rows } = await backofficePool(app).query<ContractRow & { slug: string | null }>(
        `SELECT c.*, r.slug FROM backoffice.contracts c LEFT JOIN registry.tenants r ON r.tenant_id = c.subject_tenant_id ORDER BY c.status, c.ends_on`,
      );
      return rows.map((r) => ({ ...contractJson(r), slug: r.slug }));
    },
  );

  app.post(
    '/v1/backoffice/contracts',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Record an enterprise contract (draft): custom pricing overrides, annual invoicing, payment terms, renewal dates',
        body: ContractBody,
        response: { 201: ContractT, 400: Problem, 401: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as Static<typeof ContractBody>;
      await assertCellTenant(b.tenantId);
      if (b.endsOn <= b.startsOn) throw new ApiError('validation', 'endsOn must be after startsOn');
      const problems = validateContractPricing(billingConfig(), {
        ...b.pricing,
        planId: b.planId,
        currency: b.currency,
        term: b.term,
      });
      if (problems.length) throw new ApiError('validation', problems.join('; '));
      try {
        const { rows } = await backofficePool(app).query<ContractRow>(
          `INSERT INTO backoffice.contracts (subject_tenant_id, reference, plan_id, currency, term, starts_on, ends_on, renewal, renewal_notice_days, collection, payment_terms_days, pricing, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [
            b.tenantId,
            b.reference,
            b.planId,
            b.currency,
            b.term,
            b.startsOn,
            b.endsOn,
            b.renewal,
            b.renewalNoticeDays,
            b.collection,
            b.paymentTermsDays,
            JSON.stringify(b.pricing),
            b.notes ?? null,
            req.staff!.staffId,
          ],
        );
        await staffAudit(
          app,
          req,
          'contract.created',
          {
            id: rows[0]!.id,
            reference: b.reference,
            planId: b.planId,
            currency: b.currency,
            term: b.term,
            pricing: b.pricing,
          },
          b.tenantId,
        );
        return reply.status(201).send(contractJson(rows[0]!));
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ApiError('conflict', 'Reference already used');
        throw err;
      }
    },
  );

  app.patch(
    '/v1/backoffice/contracts/:id',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        summary: 'Edit a draft contract, or the dates, renewal and notes of an active one',
        params: Type.Object({ id: Uuid }),
        body: Type.Partial(Type.Omit(ContractBody, ['tenantId'])),
        response: { 200: ContractT, 400: Problem, 401: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as Partial<Static<typeof ContractBody>>;
      const pool = backofficePool(app);
      const cur = (await pool.query<ContractRow>('SELECT * FROM backoffice.contracts WHERE id = $1', [id]))
        .rows[0];
      if (!cur) throw new ApiError('notFound');
      if (cur.status === 'ended') throw new ApiError('conflict', 'Ended contracts cannot change');
      const commercial = ['planId', 'currency', 'term', 'pricing', 'collection', 'paymentTermsDays'].filter(
        (k) => k in b,
      );
      if (cur.status === 'active' && commercial.length)
        throw new ApiError(
          'conflict',
          'End this contract and record a new one to change its commercial terms',
        );
      const next = {
        planId: b.planId ?? cur.plan_id,
        currency: b.currency ?? cur.currency,
        term: b.term ?? cur.term,
        pricing: b.pricing ?? cur.pricing,
      };
      const problems = validateContractPricing(billingConfig(), {
        ...next.pricing,
        planId: next.planId,
        currency: next.currency,
        term: next.term,
      });
      if (problems.length) throw new ApiError('validation', problems.join('; '));
      const startsOn = b.startsOn ?? cur.starts_on;
      const endsOn = b.endsOn ?? cur.ends_on;
      if (endsOn <= startsOn) throw new ApiError('validation', 'endsOn must be after startsOn');
      const { rows } = await pool.query<ContractRow>(
        `UPDATE backoffice.contracts SET reference = $2, plan_id = $3, currency = $4, term = $5, starts_on = $6, ends_on = $7, renewal = $8, renewal_notice_days = $9, collection = $10, payment_terms_days = $11, pricing = $12, notes = $13, updated_by = $14, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          id,
          b.reference ?? cur.reference,
          next.planId,
          next.currency,
          next.term,
          startsOn,
          endsOn,
          b.renewal ?? cur.renewal,
          b.renewalNoticeDays ?? cur.renewal_notice_days,
          b.collection ?? cur.collection,
          b.paymentTermsDays ?? cur.payment_terms_days,
          JSON.stringify(next.pricing),
          b.notes !== undefined ? b.notes : cur.notes,
          req.staff!.staffId,
        ],
      );
      await staffAudit(
        app,
        req,
        'contract.updated',
        { id, changed: Object.keys(b), pricing: b.pricing ?? undefined },
        cur.subject_tenant_id,
      );
      return contractJson(rows[0]!);
    },
  );

  app.post(
    '/v1/backoffice/contracts/:id/activate',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Activate: replaces self-serve billing with one contract subscription per billing account (invoice collection with payment terms; PO numbers on invoices)',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ accounts: Type.Array(Type.Object({ accountId: Uuid, status: Type.String() })) }),
          400: Problem,
          401: Problem,
          403: Problem,
          404: Problem,
          409: Problem,
          422: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const c = (
        await backofficePool(app).query<ContractRow>('SELECT * FROM backoffice.contracts WHERE id = $1', [id])
      ).rows[0];
      if (!c) throw new ApiError('notFound');
      if (c.status !== 'draft') throw new ApiError('conflict', 'Only draft contracts can be activated');
      if (await activeContract(deps.router, c.subject_tenant_id))
        throw new ApiError('conflict', 'This customer already has an active contract; end it first');
      await assertCellTenant(c.subject_tenant_id);
      const accounts = await activateContract(deps, c, req.staff!.staffId);
      await staffAudit(
        app,
        req,
        'contract.activated',
        { id, reference: c.reference, accounts: accounts.length },
        c.subject_tenant_id,
      );
      return { accounts };
    },
  );

  app.post(
    '/v1/backoffice/contracts/:id/end',
    {
      ...staff('billing'),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ endsAt: Type.String() }),
          401: Problem,
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const c = (
        await backofficePool(app).query<ContractRow>('SELECT * FROM backoffice.contracts WHERE id = $1', [id])
      ).rows[0];
      if (!c) throw new ApiError('notFound');
      if (c.status !== 'active') throw new ApiError('conflict', 'Only active contracts can end');
      const out = await endContract(deps, c, req.staff!.staffId);
      await staffAudit(app, req, 'contract.ended', { id, endsAt: out.endsAt }, c.subject_tenant_id);
      return out;
    },
  );
  void contractPricing;

  // ---- support queue (index metadata) and ticket work --------------------------------------------------
  const QueueItemT = Type.Object({
    ticketId: Uuid,
    tenantId: Uuid,
    slug: Nullable(Type.String()),
    reference: Type.String(),
    priority: Type.String(),
    status: Type.String(),
    category: Type.String(),
    planId: Type.String(),
    lastAuthor: Type.String(),
    lastActivityAt: Type.String(),
    createdAt: Type.String(),
    sla: Type.Object({
      firstResponse: Type.Object({ dueAt: Type.String(), state: Type.String() }),
      resolution: Type.Object({ dueAt: Type.String(), state: Type.String() }),
      flag: Type.String(),
    }),
  });
  app.get(
    '/v1/backoffice/support/queue',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary: "This cell's support queue with SLA flags (metadata only; open a ticket to read it)",
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('all')])),
        }),
        response: { 200: Type.Array(QueueItemT), 401: Problem, 403: Problem },
      },
    },
    async (req) => {
      const all = (req.query as { status?: string }).status === 'all';
      const { rows } = await backofficePool(app).query<
        Record<string, string | null> & { status: TicketRow['status'] }
      >(
        `SELECT q.*, r.slug FROM backoffice.support_queue q LEFT JOIN registry.tenants r ON r.tenant_id = q.subject_tenant_id
          WHERE $1 OR q.status IN ('open', 'awaiting_customer') ORDER BY q.resolution_due_at LIMIT 500`,
        [all],
      );
      const n = now();
      const order: Record<string, number> = { breached: 0, at_risk: 1, on_track: 2, met_late: 3, met: 4 };
      const pr: Record<string, number> = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
      return rows
        .map((r) => ({
          ticketId: r.ticket_id!,
          tenantId: r.subject_tenant_id!,
          slug: r.slug,
          reference: r.reference!,
          priority: r.priority!,
          status: r.status,
          category: r.category!,
          planId: r.plan_id!,
          lastAuthor: r.last_author!,
          lastActivityAt: r.last_activity_at!,
          createdAt: r.created_at!,
          sla: slaView(
            {
              first_response_due_at: r.first_response_due_at!,
              first_response_at_risk_at: r.first_response_at_risk_at!,
              resolution_due_at: r.resolution_due_at!,
              resolution_at_risk_at: r.resolution_at_risk_at!,
              first_responded_at: r.first_responded_at ?? null,
              resolved_at: r.resolved_at ?? null,
              status: r.status,
            },
            n,
          ),
        }))
        .sort(
          (a, b) =>
            order[a.sla.flag]! - order[b.sla.flag]! ||
            pr[a.priority]! - pr[b.priority]! ||
            a.sla.resolution.dueAt.localeCompare(b.sla.resolution.dueAt),
        );
    },
  );

  const TICKET = `SELECT t.*, u.display_name AS requester_name FROM app.support_tickets t JOIN app.users u ON u.tenant_id = t.tenant_id AND u.id = t.requester_user_id WHERE t.id = $1`;
  app.get(
    '/v1/backoffice/support/tickets/:tenantId/:ticketId',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary:
          'Read a ticket the customer submitted to support (audited in the customer log and the staff trail)',
        params: Type.Object({ tenantId: Uuid, ticketId: Uuid }),
        response: { 200: ThreadT, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { tenantId, ticketId } = req.params as { tenantId: string; ticketId: string };
      await assertCellTenant(tenantId);
      const thread = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const t = await tx.maybe<TicketRow & { requester_name: string }>(TICKET, [ticketId]);
          if (!t) throw new ApiError('notFound');
          return threadJson(tx, t, now());
        },
        { readOnly: true, actorId: req.staff!.staffId },
      );
      await tenantAudit(tenantId, req, 'support_ticket.viewed_by_staff', 'support_ticket', ticketId);
      await staffAudit(
        app,
        req,
        'support.ticket_viewed',
        { ticketId, reference: thread.ticket.reference },
        tenantId,
      );
      return thread;
    },
  );

  app.post(
    '/v1/backoffice/support/tickets/:tenantId/:ticketId/messages',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary: 'Reply to the customer (first reply stops the first-response timer)',
        params: Type.Object({ tenantId: Uuid, ticketId: Uuid }),
        body: Type.Object({
          body: Type.String({ minLength: 1, maxLength: 20000 }),
          status: Type.Optional(
            Type.Union([Type.Literal('open'), Type.Literal('awaiting_customer'), Type.Literal('resolved')]),
          ),
        }),
        response: { 201: Type.Object({ id: Uuid }), 401: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId, ticketId } = req.params as { tenantId: string; ticketId: string };
      const b = req.body as { body: string; status?: 'open' | 'awaiting_customer' | 'resolved' };
      await assertCellTenant(tenantId);
      const at = now();
      const { msg, t } = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const cur = await tx.maybe<TicketRow>('SELECT * FROM app.support_tickets WHERE id = $1', [
            ticketId,
          ]);
          if (!cur) throw new ApiError('notFound');
          if (cur.status === 'closed') throw new ApiError('conflict', 'The customer closed this ticket');
          const m = await tx.one<{ id: string }>(
            `INSERT INTO app.support_ticket_messages (tenant_id, ticket_id, author_type, author_staff_id, body, created_at) VALUES (app.current_tenant(), $1, 'staff', $2, $3, $4) RETURNING id`,
            [ticketId, req.staff!.staffId, b.body, at],
          );
          const status = b.status ?? 'awaiting_customer';
          const u = await tx.one<TicketRow>(
            `UPDATE app.support_tickets SET status = $2, first_responded_at = coalesce(first_responded_at, $3), resolved_at = CASE WHEN $2 = 'resolved' THEN $3::timestamptz ELSE NULL END, last_activity_at = $3 WHERE id = $1 RETURNING *`,
            [ticketId, status, at],
          );
          await writeAudit(tx, {
            actorType: 'support',
            actorId: req.staff!.staffId,
            action: 'support_ticket.staff_replied',
            targetType: 'support_ticket',
            targetId: ticketId,
            diff: { messageId: m.id, status },
            ip: req.ctx.ip,
            requestId: req.id,
          });
          await notify(tx, {
            userIds: [cur.requester_user_id],
            kind: 'support.reply',
            titleKey: 'notify.supportReply',
            params: { reference: cur.reference },
            target: { type: 'support_ticket', id: ticketId },
            dedupeKey: `support-reply:${m.id}`,
          });
          return { msg: m, t: u };
        },
        { actorId: req.staff!.staffId },
      );
      await syncQueueEntry(deps.router, tenantId, t, 'staff');
      await staffAudit(
        app,
        req,
        'support.ticket_replied',
        { ticketId, reference: t.reference, status: t.status },
        tenantId,
      );
      return reply.status(201).send(msg);
    },
  );

  app.patch(
    '/v1/backoffice/support/tickets/:tenantId/:ticketId',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary: 'Change priority (SLA deadlines are recalculated from the opening time) or status',
        params: Type.Object({ tenantId: Uuid, ticketId: Uuid }),
        body: Type.Object({
          priority: Type.Optional(Type.Union(PRIORITIES.map((p) => Type.Literal(p)))),
          status: Type.Optional(
            Type.Union([Type.Literal('open'), Type.Literal('awaiting_customer'), Type.Literal('resolved')]),
          ),
        }),
        response: { 204: Type.Null(), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId, ticketId } = req.params as { tenantId: string; ticketId: string };
      const b = req.body as { priority?: Priority; status?: TicketRow['status'] };
      await assertCellTenant(tenantId);
      const cfg = billingConfig();
      const at = now();
      const t = await withTenant(
        deps.router,
        tenantId,
        async (tx) => {
          const cur = await tx.maybe<TicketRow>('SELECT * FROM app.support_tickets WHERE id = $1', [
            ticketId,
          ]);
          if (!cur) throw new ApiError('notFound');
          const priority = b.priority ?? cur.priority;
          const d = deadlinesFor(cfg, cur.plan_id, priority, deps.config.cell, cur.created_at);
          const status = b.status ?? cur.status;
          const u = await tx.one<TicketRow>(
            `UPDATE app.support_tickets SET priority = $2, status = $3, first_response_due_at = $4, first_response_at_risk_at = $5, resolution_due_at = $6, resolution_at_risk_at = $7,
               resolved_at = CASE WHEN $3 = 'resolved' THEN coalesce(resolved_at, $8::timestamptz) ELSE NULL END,
               sla_at_risk_notified_at = CASE WHEN $2 <> priority THEN NULL ELSE sla_at_risk_notified_at END, sla_breached_notified_at = CASE WHEN $2 <> priority THEN NULL ELSE sla_breached_notified_at END, last_activity_at = $8 WHERE id = $1 RETURNING *`,
            [
              ticketId,
              priority,
              status,
              d.firstResponseDueAt,
              d.firstResponseAtRiskAt,
              d.resolutionDueAt,
              d.resolutionAtRiskAt,
              at,
            ],
          );
          await writeAudit(tx, {
            actorType: 'support',
            actorId: req.staff!.staffId,
            action: 'support_ticket.staff_updated',
            targetType: 'support_ticket',
            targetId: ticketId,
            diff: {
              priority: { from: cur.priority, to: priority },
              status: { from: cur.status, to: status },
            },
            ip: req.ctx.ip,
            requestId: req.id,
          });
          return u;
        },
        { actorId: req.staff!.staffId },
      );
      await syncQueueEntry(deps.router, tenantId, t, 'staff');
      await staffAudit(
        app,
        req,
        'support.ticket_updated',
        { ticketId, priority: t.priority, status: t.status },
        tenantId,
      );
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/backoffice/support/tickets/:tenantId/:ticketId/attachments/:attachmentId',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ tenantId: Uuid, ticketId: Uuid, attachmentId: Uuid }),
        response: { 200: Type.Object({ url: Type.String() }), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { tenantId, ticketId, attachmentId } = req.params as {
        tenantId: string;
        ticketId: string;
        attachmentId: string;
      };
      await assertCellTenant(tenantId);
      const a = await withTenant(
        deps.router,
        tenantId,
        (tx) =>
          tx.maybe<{ object_key: string; file_name: string }>(
            'SELECT object_key, file_name FROM app.support_ticket_attachments WHERE id = $1 AND ticket_id = $2',
            [attachmentId, ticketId],
          ),
        { readOnly: true },
      );
      if (!a) throw new ApiError('notFound');
      await tenantAudit(
        tenantId,
        req,
        'support_ticket.attachment_viewed_by_staff',
        'support_ticket',
        ticketId,
        { attachmentId },
      );
      await staffAudit(app, req, 'support.attachment_viewed', { ticketId, attachmentId }, tenantId);
      return { url: await deps.objects.presignGet(a.object_key, a.file_name) };
    },
  );

  // ---- personal data: ONLY through a customer-granted, logged support grant ----------------------------
  app.get(
    '/v1/backoffice/grants',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary: 'Support grants customers have given this staff member (active and past)',
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              tenantId: Uuid,
              slug: Nullable(Type.String()),
              accessLevel: Type.String(),
              startsAt: Type.String(),
              expiresAt: Type.String(),
              revokedAt: Nullable(Type.String()),
              active: Type.Boolean(),
            }),
          ),
          401: Problem,
          403: Problem,
        },
      },
    },
    async (req) => {
      const { rows } = await backofficePool(app).query<{
        id: string;
        tenant_id: string;
        slug: string | null;
        access_level: string;
        starts_at: string;
        expires_at: string;
        revoked_at: string | null;
        active: boolean;
      }>(
        `SELECT g.id, g.tenant_id, r.slug, g.access_level, g.starts_at, g.expires_at, g.revoked_at, (g.revoked_at IS NULL AND now() >= g.starts_at AND now() < g.expires_at) AS active
           FROM app.support_grants g LEFT JOIN registry.tenants r ON r.tenant_id = g.tenant_id WHERE g.staff_id = $1 ORDER BY g.expires_at DESC LIMIT 200`,
        [req.staff!.staffId],
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        slug: r.slug,
        accessLevel: r.access_level,
        startsAt: r.starts_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        active: r.active,
      }));
    },
  );

  app.get(
    '/v1/backoffice/tenants/:tenantId/employees/:employeeId',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary:
          'View an employee record to debug an issue: requires an active support grant from the customer; audited in both logs',
        params: Type.Object({ tenantId: Uuid, employeeId: Uuid }),
        response: { 200: Type.Any(), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { tenantId, employeeId } = req.params as { tenantId: string; employeeId: string };
      await assertCellTenant(tenantId);
      return withSupportAccess(
        { router: deps.router, backofficeDbUrl: deps.backofficeDbUrl! },
        req.staff!.staffId,
        tenantId,
        'view_employee',
        async (tx) => {
          if (!(await tx.maybe('SELECT 1 FROM app.employees WHERE id = $1', [employeeId])))
            throw new ApiError('notFound');
          return employeeAsOf(tx, employeeId, today());
        },
        meta(req),
      );
    },
  );

  const EmployeeFix = Type.Object(
    {
      workEmail: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 254 }))),
      workPhone: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
    },
    { minProperties: 1 },
  );
  app.patch(
    '/v1/backoffice/tenants/:tenantId/employees/:employeeId',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary:
          "Correct an employee's work contact details: requires a read-and-write support grant; audited in both logs",
        params: Type.Object({ tenantId: Uuid, employeeId: Uuid }),
        body: EmployeeFix,
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId, employeeId } = req.params as { tenantId: string; employeeId: string };
      const b = req.body as Static<typeof EmployeeFix>;
      await assertCellTenant(tenantId);
      await withSupportAccess(
        { router: deps.router, backofficeDbUrl: deps.backofficeDbUrl! },
        req.staff!.staffId,
        tenantId,
        'update_employee',
        async (tx) => {
          const n = await tx.exec(
            `UPDATE app.employees SET work_email = CASE WHEN $2 THEN $3 ELSE work_email END, work_phone = CASE WHEN $4 THEN $5 ELSE work_phone END WHERE id = $1`,
            [employeeId, 'workEmail' in b, b.workEmail ?? null, 'workPhone' in b, b.workPhone ?? null],
          );
          if (!n) throw new ApiError('notFound');
          await writeAudit(tx, {
            actorType: 'support',
            actorId: req.staff!.staffId,
            action: 'employee.updated_by_support',
            targetType: 'employee',
            targetId: employeeId,
            diff: { changed: Object.keys(b) },
            ip: req.ctx.ip,
            requestId: req.id,
          });
        },
        { ...meta(req), write: true },
      );
      return reply.status(204).send(null);
    },
  );

  // ---- staff audit trail (append-only; exportable) -----------------------------------------------------
  const AuditQ = Type.Object({
    from: Type.String({ format: 'date-time' }),
    to: Type.String({ format: 'date-time' }),
    format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])),
    staffId: Type.Optional(Uuid),
  });
  const AuditRow = Type.Object({
    id: Type.String(),
    at: Type.String(),
    staffId: Nullable(Type.String()),
    staffEmail: Nullable(Type.String()),
    action: Type.String(),
    subjectTenantId: Nullable(Type.String()),
    target: Nullable(Type.String()),
    detail: Type.Any(),
    ip: Nullable(Type.String()),
    requestId: Nullable(Type.String()),
  });
  app.get(
    '/v1/backoffice/audit',
    {
      ...staff(),
      schema: {
        tags: ['backoffice'],
        summary: 'Staff audit trail (super admins). format=csv exports it; every export is itself recorded.',
        querystring: AuditQ,
        response: { 200: Type.Union([Type.Array(AuditRow), Type.String()]), 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const q = req.query as Static<typeof AuditQ>;
      const { rows } = await backofficePool(app).query<{
        id: string;
        at: string;
        staff_id: string | null;
        email: string | null;
        action: string;
        subject_tenant_id: string | null;
        target: string | null;
        detail: unknown;
        ip: string | null;
        request_id: string | null;
      }>(
        `SELECT a.id::text, a.at, a.staff_id, u.email::text, a.action, a.subject_tenant_id, a.target, a.detail, host(a.ip) AS ip, a.request_id FROM backoffice.staff_audit a LEFT JOIN backoffice.staff_users u ON u.id = a.staff_id
          WHERE a.at >= $1 AND a.at < $2 AND ($3::uuid IS NULL OR a.staff_id = $3) ORDER BY a.id LIMIT 50000`,
        [q.from, q.to, q.staffId ?? null],
      );
      const out = rows.map((r) => ({
        id: r.id,
        at: r.at,
        staffId: r.staff_id,
        staffEmail: r.email,
        action: r.action,
        subjectTenantId: r.subject_tenant_id,
        target: r.target,
        detail: r.detail,
        ip: r.ip,
        requestId: r.request_id,
      }));
      if (q.format === 'csv') {
        await staffAudit(app, req, 'staff_audit.exported', { from: q.from, to: q.to, rows: out.length });
        const cell = (v: unknown) => {
          let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
          if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = 'id,at,staffId,staffEmail,action,subjectTenantId,target,detail,ip,requestId';
        const lines = out.map((r) =>
          [
            r.id,
            r.at,
            r.staffId,
            r.staffEmail,
            r.action,
            r.subjectTenantId,
            r.target,
            r.detail,
            r.ip,
            r.requestId,
          ]
            .map(cell)
            .join(','),
        );
        reply.header('content-disposition', `attachment; filename="staff-audit-${deps.config.cell}.csv"`);
        return reply.type('text/csv; charset=utf-8').send([header, ...lines].join('\r\n'));
      }
      return out;
    },
  );

  // ---- support contact channels per region and plan (append-only settings) ------------------------------
  const Channel = Type.Object({
    kind: Type.Union(['help_centre', 'ticket', 'email', 'phone', 'chat'].map((k) => Type.Literal(k))),
    value: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    hours: Type.Optional(Type.Union([Type.Literal('business_hours'), Type.Literal('always')])),
  });
  const ChannelMap = Type.Record(
    Type.String({ pattern: '^[a-z0-9_-]{1,40}$' }),
    Type.Array(Channel, { maxItems: 10 }),
  );
  app.get(
    '/v1/backoffice/settings/contact-channels',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({ region: Type.String(), defaults: ChannelMap, override: Nullable(ChannelMap) }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const cfg = billingConfig();
      const o = await contactOverrides(deps.router);
      return {
        region: deps.config.cell,
        defaults: cfg.support.contactChannels as Record<string, Static<typeof Channel>[]>,
        override: (o?.[deps.config.cell] as Record<string, Static<typeof Channel>[]> | undefined) ?? null,
      };
    },
  );
  app.put(
    '/v1/backoffice/settings/contact-channels',
    {
      ...staff('support'),
      schema: {
        tags: ['backoffice'],
        summary: "Override this region's contact channels per plan (newest version wins; history kept)",
        body: Type.Object({ channels: ChannelMap }),
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const { channels } = req.body as { channels: Record<string, ContactChannel[]> };
      const cfg = billingConfig();
      for (const plan of Object.keys(channels))
        if (!planById(cfg, plan)) throw new ApiError('validation', `Unknown plan ${plan}`);
      const pool = backofficePool(app);
      const cur = (await contactOverrides(deps.router)) ?? {};
      const next = { ...cur, [deps.config.cell]: channels };
      for (const r of HOME_REGIONS) if (!(r in next)) delete (next as Record<string, unknown>)[r];
      await pool.query(
        `INSERT INTO backoffice.settings_versions (key, value, created_by) VALUES ('support.contact_channels', $1, $2)`,
        [JSON.stringify(next), req.staff!.staffId],
      );
      await staffAudit(app, req, 'settings.contact_channels_updated', {
        region: deps.config.cell,
        plans: Object.keys(channels),
      });
      return reply.status(204).send(null);
    },
  );

  // ---- jurisdiction rules catalogue for the rule-editing screen (the versions API is in modules/rules) --
  app.get(
    '/v1/backoffice/rules/catalogue',
    {
      ...staff('rules_editor'),
      schema: {
        tags: ['backoffice'],
        response: {
          200: Type.Object({
            jurisdictions: Type.Array(
              Type.Object({
                code: Type.String(),
                name: Type.String(),
                parent: Nullable(Type.String()),
                version: Type.Integer(),
                keys: Type.Array(Type.String()),
              }),
            ),
            keys: Type.Array(Type.Object({ key: Type.String(), description: Type.String() })),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => ({
      jurisdictions: rules()
        .jurisdictions()
        .map((p) => ({
          code: p.jurisdiction,
          name: p.name,
          parent: p.parent,
          version: p.version,
          keys: p.rules.map((r) => r.key),
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
      keys: Object.entries(RULE_KEYS).map(([key, description]) => ({ key, description })),
    }),
  );
}
