import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import {
  BILLING_CURRENCIES,
  PricingError,
  quote,
  type BillingCurrency,
  type Term,
} from '@thapsus/core/billing';
import { withTenant } from '@thapsus/db';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { verifyWebhook, WebhookSignatureError } from './provider';
import {
  accountComplete,
  billingConfig,
  billingProvider,
  cancelSubscription,
  changeSubscription,
  contractPricing,
  ensureBillingDefaults,
  headcounts,
  loadContext,
  previewChange,
  quoteJson,
  reactivateSubscription,
  startSubscription,
  syncCustomer,
  type AccountRow,
  type SubRow,
} from './service';
import { handleBillingEvent } from './webhook';
import { startPendingContractSubscriptions } from './contracts';
import './jobs';

const Currency = Type.Union(BILLING_CURRENCIES.map((c) => Type.Literal(c)));
const TermT = Type.Union([Type.Literal('monthly'), Type.Literal('annual')]);
const MoneyT = Type.Object({ amountMinor: Type.Integer(), currency: Type.String() });
const QuoteT = Type.Object({
  planId: Type.String(),
  term: Type.String(),
  currency: Type.String(),
  interval: Type.String(),
  headcount: Type.Integer(),
  quantity: Type.Integer(),
  bandId: Nullable(Type.String()),
  unitAmount: MoneyT,
  listAmount: MoneyT,
  discountAmount: MoneyT,
  totalAmount: MoneyT,
  monthlyEquivalent: MoneyT,
  discountCode: Nullable(Type.String()),
  source: Type.String(),
  configVersion: Type.Integer(),
});
const Address = Type.Object({
  line1: Type.String({ minLength: 1, maxLength: 200 }),
  line2: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  city: Type.String({ minLength: 1, maxLength: 100 }),
  region: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  postalCode: Type.String({ minLength: 1, maxLength: 20 }),
  country: Type.String({ pattern: '^[A-Z]{2}$' }),
});
const SubscriptionT = Type.Object({
  id: Uuid,
  billingAccountId: Uuid,
  planId: Type.String(),
  term: Type.String(),
  currency: Type.String(),
  status: Type.String(),
  source: Type.String(),
  trialEndsAt: Nullable(Type.String()),
  currentPeriodStart: Nullable(Type.String()),
  currentPeriodEnd: Nullable(Type.String()),
  quantity: Type.Integer(),
  bandId: Nullable(Type.String()),
  unitAmount: MoneyT,
  intervalAmount: MoneyT,
  pendingChange: Nullable(
    Type.Object({
      kind: Type.String(),
      planId: Type.String(),
      term: Type.String(),
      effectiveAt: Type.String(),
    }),
  ),
  cancelEffectiveAt: Nullable(Type.String()),
  hasProviderSubscription: Type.Boolean(),
});
const AccountT = Type.Object({
  id: Uuid,
  name: Type.String(),
  isDefault: Type.Boolean(),
  currency: Type.String(),
  address: Type.Record(Type.String(), Type.Any()),
  companyTaxId: Nullable(Type.String()),
  companyTaxIdType: Nullable(Type.String()),
  poNumber: Nullable(Type.String()),
  collection: Type.String(),
  paymentTermsDays: Nullable(Type.Integer()),
  hasPaymentMethod: Type.Boolean(),
  detailsComplete: Type.Boolean(),
  headcount: Type.Integer(),
  entityIds: Type.Array(Uuid),
  contacts: Type.Array(
    Type.Object({ id: Uuid, name: Type.String(), email: Type.String(), isPrimary: Type.Boolean() }),
  ),
  subscription: Nullable(SubscriptionT),
});

export function subJson(s: SubRow) {
  return {
    id: s.id,
    billingAccountId: s.billing_account_id,
    planId: s.plan_id,
    term: s.term,
    currency: s.currency,
    status: s.status,
    source: s.source,
    trialEndsAt: s.trial_ends_at,
    currentPeriodStart: s.current_period_start,
    currentPeriodEnd: s.current_period_end,
    quantity: s.quantity,
    bandId: s.band_id,
    unitAmount: { amountMinor: Number(s.unit_amount_minor), currency: s.currency },
    intervalAmount: { amountMinor: Number(s.interval_amount_minor), currency: s.currency },
    pendingChange: s.pending_change
      ? {
          kind: s.pending_change.kind,
          planId: s.pending_change.planId,
          term: s.pending_change.term,
          effectiveAt: s.pending_change.effectiveAt,
        }
      : null,
    cancelEffectiveAt: s.cancel_effective_at,
    hasProviderSubscription: !!s.provider_subscription_id,
  };
}

function pricingError(err: unknown): never {
  if (err instanceof PricingError)
    throw new ApiError(
      err.code === 'invalidDiscountCode' || err.code === 'unsupportedCurrency' || err.code === 'unknownPlan'
        ? 'validation'
        : 'unprocessable',
      err.code,
      { reason: err.code },
    );
  throw err;
}

/** Tenant billing (owners) and the provider webhook. */
export async function billingRoutes(app: FastifyInstance) {
  const deps = app.deps;

  // ---- public price list (no auth; no personal data; the marketing site renders the same config) -----
  app.get(
    '/v1/billing/plans',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['billing'],
        summary:
          'Published self-serve plans, bands and prices (integer minor units, excluding tax) from the billing configuration',
        response: {
          200: Type.Object({
            configVersion: Type.Integer(),
            currencies: Type.Array(Type.String()),
            trialDays: Type.Integer(),
            terms: Type.Record(
              Type.String(),
              Type.Object({
                interval: Type.String(),
                months: Type.Integer(),
                cancellationNoticeDays: Type.Integer(),
                discountBasisPoints: Type.Integer(),
              }),
            ),
            plans: Type.Array(
              Type.Object({
                id: Type.String(),
                rank: Type.Integer(),
                selfServe: Type.Boolean(),
                minimumEmployees: Type.Integer(),
                features: Type.Array(Type.String()),
                bands: Type.Array(
                  Type.Object({
                    id: Type.String(),
                    minEmployees: Type.Integer(),
                    maxEmployees: Type.Integer(),
                    monthlyUnit: Type.Record(Type.String(), Type.Integer()),
                  }),
                ),
                support: Type.Object({
                  coverage: Type.String(),
                  sla: Type.Record(
                    Type.String(),
                    Type.Object({ firstResponseMinutes: Type.Integer(), resolutionMinutes: Type.Integer() }),
                  ),
                }),
              }),
            ),
          }),
        },
      },
    },
    async () => {
      const cfg = billingConfig();
      return {
        configVersion: cfg.version,
        currencies: cfg.currencies,
        trialDays: cfg.trial.days,
        terms: Object.fromEntries(
          Object.entries(cfg.terms).map(([k, v]) => [
            k,
            {
              interval: v.interval,
              months: v.months,
              cancellationNoticeDays: v.cancellationNoticeDays,
              discountBasisPoints: cfg.discounts.terms[k as Term],
            },
          ]),
        ),
        plans: cfg.plans.map((p) => ({
          id: p.id,
          rank: p.rank,
          selfServe: p.selfServe,
          minimumEmployees: p.minimumEmployees,
          features: p.features,
          bands: p.bands,
          support: p.support,
        })),
      };
    },
  );

  // ---- owner billing overview ----------------------------------------------------------------------
  app.get(
    '/v1/billing',
    {
      schema: {
        tags: ['billing'],
        response: {
          200: Type.Object({
            region: Type.String(),
            accounts: Type.Array(AccountT),
            contract: Nullable(
              Type.Object({
                reference: Type.String(),
                planId: Type.String(),
                term: Type.String(),
                currency: Type.String(),
                startsOn: Type.String(),
                endsOn: Type.String(),
                renewal: Type.String(),
                collection: Type.String(),
                paymentTermsDays: Type.Integer(),
              }),
            ),
            selfServe: Type.Boolean(),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorize(req, 'billing.manage');
      const ctx = await loadContext(app, auth.tenantId);
      const accounts = await app.tenantTx(
        req,
        async (tx) => {
          const rows = await tx.query<AccountRow>(
            'SELECT * FROM app.billing_accounts ORDER BY is_default DESC, name',
          );
          const counts = await headcounts(tx);
          const out = [];
          for (const a of rows) {
            const contacts = await tx.query<{ id: string; name: string; email: string; is_primary: boolean }>(
              'SELECT id, name, email, is_primary FROM app.billing_contacts WHERE billing_account_id = $1 ORDER BY is_primary DESC, created_at',
              [a.id],
            );
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
              address: a.address,
              companyTaxId: a.company_tax_id,
              companyTaxIdType: a.company_tax_id_type,
              poNumber: a.po_number,
              collection: a.collection,
              paymentTermsDays: a.payment_terms_days,
              hasPaymentMethod: a.has_payment_method,
              detailsComplete: accountComplete(
                a,
                contacts.find((c) => c.is_primary),
              ),
              headcount: counts.get(a.id) ?? 0,
              entityIds,
              contacts: contacts.map((c) => ({
                id: c.id,
                name: c.name,
                email: c.email,
                isPrimary: c.is_primary,
              })),
              subscription: sub ? subJson(sub) : null,
            });
          }
          return out;
        },
        { readOnly: true },
      );
      const c = ctx.contract;
      return {
        region: deps.config.cell,
        accounts,
        contract: c
          ? {
              reference: c.reference,
              planId: c.plan_id,
              term: c.term,
              currency: c.currency,
              startsOn: c.starts_on,
              endsOn: c.ends_on,
              renewal: c.renewal,
              collection: c.collection,
              paymentTermsDays: c.payment_terms_days,
            }
          : null,
        selfServe: !c,
      };
    },
  );

  const Details = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    address: Address,
    companyTaxId: Type.Optional(
      Nullable(
        Type.Object({
          type: Type.String({ pattern: '^[a-z]{2}_[a-z]{2,5}$' }),
          value: Type.String({ minLength: 2, maxLength: 40 }),
        }),
      ),
    ),
    contacts: Type.Array(
      Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        email: Type.String({ format: 'email', maxLength: 254 }),
        isPrimary: Type.Boolean(),
      }),
      { minItems: 1, maxItems: 5 },
    ),
  });
  app.put(
    '/v1/billing/accounts/:id/details',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Company billing details and billing contacts (failed-payment emails go to every contact)',
        params: Type.Object({ id: Uuid }),
        body: Details,
        response: { 204: Type.Null(), 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'billing.manage');
      const { id } = req.params as { id: string };
      const b = req.body as Static<typeof Details>;
      if (b.contacts.filter((c) => c.isPrimary).length !== 1)
        throw new ApiError('validation', 'Choose exactly one primary billing contact');
      await app.tenantTx(req, async (tx) => {
        await ensureBillingDefaults(tx, billingConfig(), deps.now());
        const n = await tx.exec(
          'UPDATE app.billing_accounts SET name = $2, address = $3, company_tax_id = $4, company_tax_id_type = $5 WHERE id = $1',
          [
            id,
            b.name,
            JSON.stringify(b.address),
            b.companyTaxId?.value ?? null,
            b.companyTaxId?.type ?? null,
          ],
        );
        if (!n) throw new ApiError('notFound');
        await tx.exec('DELETE FROM app.billing_contacts WHERE billing_account_id = $1', [id]);
        for (const c of b.contacts)
          await tx.exec(
            'INSERT INTO app.billing_contacts (tenant_id, billing_account_id, name, email, is_primary) VALUES (app.current_tenant(), $1, $2, $3, $4)',
            [id, c.name, c.email.toLowerCase(), c.isPrimary],
          );
        // The diff records what changed, not the contacts' names or emails.
        await app.audit(tx, req, {
          action: 'billing.details_updated',
          targetType: 'billing_account',
          targetId: id,
          diff: { contacts: b.contacts.length, country: b.address.country, companyTaxId: !!b.companyTaxId },
        });
      });
      const acct = await app.tenantTx(
        req,
        (tx) => tx.one<AccountRow>('SELECT * FROM app.billing_accounts WHERE id = $1', [id]),
        { readOnly: true },
      );
      // Keep the provider customer current; a contract subscription waiting for these details starts now.
      if (acct.provider_customer_id) await syncCustomer(deps, auth.tenantId, id);
      await startPendingContractSubscriptions(deps, auth.tenantId, id);
      return reply.status(204).send(null);
    },
  );

  const Target = Type.Object({
    planId: Type.String({ maxLength: 40 }),
    term: TermT,
    currency: Type.Optional(Currency),
    discountCode: Type.Optional(Nullable(Type.String({ maxLength: 32 }))),
  });
  const PreviewT = Type.Object({
    kind: Type.String(),
    effectiveAt: Type.String(),
    quote: QuoteT,
    proration: Nullable(
      Type.Object({
        credit: MoneyT,
        charge: MoneyT,
        net: MoneyT,
        remainingMinutes: Type.Integer(),
        periodMinutes: Type.Integer(),
      }),
    ),
  });
  const previewOut = (p: ReturnType<typeof previewChange>) => ({
    kind: p.kind,
    effectiveAt: p.effectiveAt,
    quote: quoteJson(p.quote),
    proration: p.proration
      ? {
          credit: {
            amountMinor: Number(p.proration.credit.amountMinor),
            currency: p.proration.credit.currency,
          },
          charge: {
            amountMinor: Number(p.proration.charge.amountMinor),
            currency: p.proration.charge.currency,
          },
          net: { amountMinor: Number(p.proration.net.amountMinor), currency: p.proration.net.currency },
          remainingMinutes: p.proration.remainingMinutes,
          periodMinutes: p.proration.periodMinutes,
        }
      : null,
  });

  app.post(
    '/v1/billing/quote',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Price and change preview for the current headcount (nothing is changed)',
        body: Target,
        response: { 200: PreviewT, 400: Problem, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'billing.manage');
      const b = req.body as Static<typeof Target>;
      const ctx = await loadContext(app, auth.tenantId);
      try {
        if (ctx.contract)
          return previewOut({
            kind: 'none',
            effectiveAt: deps.now().toISOString(),
            quote: quote(ctx.cfg, {
              planId: b.planId,
              term: b.term,
              currency: ctx.contract.currency,
              headcount: ctx.headcount,
              contract: contractPricing(ctx.contract),
            }),
            proration: null,
          });
        const currency = (
          ctx.sub?.provider_subscription_id ? ctx.sub.currency : (b.currency ?? ctx.account.currency)
        ) as BillingCurrency;
        return previewOut(
          previewChange(
            ctx,
            {
              planId: b.planId,
              term: b.term as Term,
              currency,
              discountCode: b.discountCode ?? ctx.sub?.discount_code,
            },
            deps.now().toISOString(),
          ),
        );
      } catch (err) {
        pricingError(err);
      }
    },
  );

  app.post(
    '/v1/billing/subscription',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Choose a self-serve plan, term and currency (keeps any trial days left)',
        body: Type.Object({
          planId: Type.String({ maxLength: 40 }),
          term: TermT,
          currency: Currency,
          discountCode: Type.Optional(Nullable(Type.String({ maxLength: 32 }))),
        }),
        response: {
          201: Type.Object({ id: Uuid, status: Type.String(), quote: QuoteT }),
          400: Problem,
          403: Problem,
          409: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'billing.manage');
      const b = req.body as {
        planId: string;
        term: Term;
        currency: BillingCurrency;
        discountCode?: string | null;
      };
      req.auditWritten = true;
      try {
        const r = await startSubscription(app, auth.tenantId, auth.userId, b);
        return reply.status(201).send({ id: r.id, status: r.status, quote: quoteJson(r.quote) });
      } catch (err) {
        pricingError(err);
      }
    },
  );

  app.post(
    '/v1/billing/subscription/change',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Upgrade (now, prorated) or downgrade (end of the paid period)',
        body: Type.Object({ planId: Type.String({ maxLength: 40 }), term: TermT }),
        response: { 200: PreviewT, 400: Problem, 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'billing.manage');
      req.auditWritten = true;
      try {
        return previewOut(
          await changeSubscription(
            app,
            auth.tenantId,
            auth.userId,
            req.body as { planId: string; term: Term },
          ),
        );
      } catch (err) {
        pricingError(err);
      }
    },
  );

  app.post(
    '/v1/billing/subscription/cancel',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Cancel with notice: ends at the first period end after the notice period',
        response: { 200: Type.Object({ effectiveAt: Type.String() }), 403: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'billing.manage');
      req.auditWritten = true;
      return cancelSubscription(app, auth.tenantId, auth.userId);
    },
  );

  app.post(
    '/v1/billing/subscription/reactivate',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Withdraw a cancellation before it takes effect',
        response: { 204: Type.Null(), 403: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'billing.manage');
      req.auditWritten = true;
      await reactivateSubscription(app, auth.tenantId, auth.userId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/billing/payment-method',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['billing'],
        summary: 'Start a hosted page to add a card (card details never reach Thapsus-HR)',
        body: Type.Object({ accountId: Type.Optional(Uuid) }),
        response: { 200: Type.Object({ url: Type.String() }), 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'billing.manage');
      const ctx = await loadContext(app, auth.tenantId, (req.body as { accountId?: string }).accountId);
      const customerId =
        ctx.account.provider_customer_id ?? (await syncCustomer(deps, auth.tenantId, ctx.account.id));
      if (!customerId)
        throw new ApiError('unprocessable', 'Add your billing details first', {
          code: 'billingDetailsRequired',
        });
      const out = await billingProvider(deps).createPaymentSetupSession({
        customerId,
        currency: ctx.account.currency,
        returnUrl: `${deps.config.appBaseUrl}/app/billing`,
        idempotencyKey: `setup:${ctx.account.id}:${deps.now().toISOString()}`,
      });
      await withTenant(deps.router, auth.tenantId, (tx) =>
        app.audit(tx, req, {
          action: 'billing.payment_setup_started',
          targetType: 'billing_account',
          targetId: ctx.account.id,
        }),
      );
      return out;
    },
  );

  app.get(
    '/v1/billing/invoices',
    {
      schema: {
        tags: ['billing'],
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              billingAccountId: Uuid,
              number: Nullable(Type.String()),
              status: Type.String(),
              currency: Type.String(),
              subtotal: MoneyT,
              tax: MoneyT,
              total: MoneyT,
              amountDue: MoneyT,
              periodStart: Nullable(Type.String()),
              periodEnd: Nullable(Type.String()),
              dueAt: Nullable(Type.String()),
              hostedUrl: Nullable(Type.String()),
              poNumber: Nullable(Type.String()),
              paymentFailedAt: Nullable(Type.String()),
              createdAt: Type.String(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'billing.manage');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<Record<string, string | null>>(
            'SELECT * FROM app.billing_invoices ORDER BY created_at DESC LIMIT 200',
          ),
        { readOnly: true },
      );
      const m = (v: string | null | undefined, c: string | null | undefined) => ({
        amountMinor: Number(v ?? 0),
        currency: c ?? '',
      });
      return rows.map((r) => ({
        id: r.id!,
        billingAccountId: r.billing_account_id!,
        number: r.number,
        status: r.status!,
        currency: r.currency!,
        subtotal: m(r.subtotal_minor, r.currency),
        tax: m(r.tax_minor, r.currency),
        total: m(r.total_minor, r.currency),
        amountDue: m(r.amount_due_minor, r.currency),
        periodStart: r.period_start,
        periodEnd: r.period_end,
        dueAt: r.due_at,
        hostedUrl: r.hosted_url,
        poNumber: r.po_number,
        paymentFailedAt: r.payment_failed_at,
        createdAt: r.created_at!,
      }));
    },
  );

  // ---- provider webhook (raw body for signature verification; encapsulated content parser) ------------
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    sub.post(
      '/v1/billing/webhooks/stripe',
      {
        config: { auth: 'public', selfAudited: true },
        bodyLimit: 512 * 1024,
        schema: {
          tags: ['billing'],
          summary:
            'Stripe webhook (signature verified, idempotent per event id; events for other regions are ignored)',
          response: {
            200: Type.Object({ received: Type.Literal(true), outcome: Type.String() }),
            400: Problem,
            503: Problem,
          },
        },
      },
      async (req) => {
        const secret = deps.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) throw new ApiError('tenantUnavailable', 'Webhooks are not configured');
        let event;
        try {
          event = verifyWebhook(
            req.body as Buffer,
            req.headers['stripe-signature'] as string | undefined,
            secret,
            deps.now().getTime(),
          );
        } catch (err) {
          if (err instanceof WebhookSignatureError) throw new ApiError('validation', 'Invalid signature');
          throw err;
        }
        const outcome = await handleBillingEvent(deps, event);
        return { received: true as const, outcome };
      },
    );
  });
}
