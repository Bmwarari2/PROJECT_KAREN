import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { HOME_REGIONS, type HomeRegion } from '@thapsus/core';
import {
  conversionBasisPoints,
  recurringRevenue,
  weekStarts,
  weeklyCounts,
  type RecurringLine,
} from '@thapsus/core/metrics';
import { instantToDate } from '@thapsus/core/time';
import { Nullable, Problem } from '../../http/schemas';
import { backofficePool, requireStaff } from './auth';

/**
 * Business figures for the founder's console (ADR-0175). Aggregates only, never personal data:
 *  - GET /v1/backoffice/metrics: this cell, from the regional registry, the usage snapshot (refreshed
 *    daily per customer by billing.daily), the support queue index, contracts and status incidents.
 *  - GET /v1/backoffice/metrics/global: every region, from the global tenant directory only (ids,
 *    regions, plan, status and sign-up time), so nothing leaves its home region.
 */
export const SIGNUP_WEEKS = 12;
export const TRIAL_ENDING_DAYS = 14;

const CountT = Type.Object({ key: Nullable(Type.String()), count: Type.Integer() });
const RevenueT = Type.Object({ currency: Type.String(), mrrMinor: Type.Integer(), arrMinor: Type.Integer() });
const WeekT = Type.Object({ weekStart: Type.String({ format: 'date' }), count: Type.Integer() });

export const CellMetricsT = Type.Object({
  cell: Type.String(),
  generatedAt: Type.String(),
  snapshot: Type.Object({
    oldest: Nullable(Type.String()),
    newest: Nullable(Type.String()),
    missing: Type.Integer({ description: 'Customers without a usage snapshot yet' }),
  }),
  companies: Type.Object({
    total: Type.Integer(),
    new7d: Type.Integer(),
    new30d: Type.Integer(),
    byStatus: Type.Array(CountT),
    byPlan: Type.Array(CountT),
    byBillingStatus: Type.Array(CountT),
  }),
  signups: Type.Array(WeekT),
  trials: Type.Object({
    active: Type.Integer(),
    endingSoon: Type.Integer(),
    endingSoonDays: Type.Integer(),
    ended: Type.Integer(),
    converted: Type.Integer(),
    conversionBasisPoints: Nullable(Type.Integer()),
  }),
  churn: Type.Object({ cancelled: Type.Integer(), cancelled30d: Type.Integer(), closing: Type.Integer() }),
  usage: Type.Object({
    activeUsers7d: Type.Integer(),
    activeUsers30d: Type.Integer(),
    users: Type.Integer(),
    usersWithMfa: Type.Integer(),
    employees: Type.Integer(),
  }),
  revenue: Type.Array(RevenueT),
  support: Type.Object({
    openTickets: Type.Integer(),
    slaAtRisk: Type.Integer(),
    slaBreached: Type.Integer(),
  }),
  contracts: Type.Object({ active: Type.Integer(), renewalsDue: Type.Integer() }),
  incidents: Type.Object({ active: Type.Integer() }),
});

export const GlobalMetricsT = Type.Object({
  generatedAt: Type.String(),
  thisCell: Type.String(),
  regions: Type.Array(
    Type.Object({
      region: Type.String(),
      total: Type.Integer(),
      new7d: Type.Integer(),
      new30d: Type.Integer(),
      signups: Type.Array(WeekT),
      byPlan: Type.Array(CountT),
      byStatus: Type.Array(CountT),
      appUrl: Type.String(),
    }),
  ),
});

const counted = (m: Map<string | null, number>) =>
  [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
const tally = <T>(rows: T[], key: (r: T) => string | null) => {
  const m = new Map<string | null, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return counted(m);
};

export async function backofficeMetricsRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const guard = {
    config: { auth: 'public' as const, selfAudited: true },
    // read-only aggregates: every permitted staff member, elevated or not
    preHandler: requireStaff(app, ['support', 'billing'], { noElevation: true }),
  };

  app.get(
    '/v1/backoffice/metrics',
    {
      ...guard,
      schema: {
        tags: ['backoffice'],
        summary: "This cell's business figures: companies, trials, churn, usage, revenue (counts only)",
        response: { 200: CellMetricsT, 401: Problem, 403: Problem },
      },
    },
    async () => {
      const pool = backofficePool(app);
      const now = deps.now();
      const at = now.toISOString();
      const today = instantToDate(at, 'UTC');
      const cell = deps.config.cell;
      const [tenants, revenue, support, contracts, incidents] = await Promise.all([
        pool.query<{
          status: string;
          created_at: string;
          updated_at: string;
          plan_id: string | null;
          billing_status: string | null;
          computed_at: string | null;
          trial_ends_at: string | null;
          cancelled_at: string | null;
          headcount: number | null;
          active_users: number | null;
          active_users_7d: number | null;
          active_users_30d: number | null;
          users_with_mfa: number | null;
        }>(
          `SELECT r.status, r.created_at, r.updated_at, u.plan_id, u.billing_status, u.computed_at, u.trial_ends_at, u.cancelled_at,
                  u.headcount, u.active_users, u.active_users_7d, u.active_users_30d, u.users_with_mfa
             FROM registry.tenants r LEFT JOIN backoffice.tenant_usage u ON u.subject_tenant_id = r.tenant_id
            WHERE r.home_region = $1`,
          [cell],
        ),
        // live paid lines summed per currency and term in SQL (bigint sums stay exact)
        pool.query<{ currency: string; term: string; amount: string }>(
          `SELECT l->>'currency' AS currency, l->>'term' AS term, sum((l->>'intervalAmountMinor')::numeric)::text AS amount
             FROM registry.tenants r JOIN backoffice.tenant_usage u ON u.subject_tenant_id = r.tenant_id
             CROSS JOIN LATERAL jsonb_array_elements(coalesce(u.recurring, '[]'::jsonb)) l
            WHERE r.home_region = $1 AND r.status IN ('active', 'moving') GROUP BY 1, 2`,
          [cell],
        ),
        pool.query<{ open: number; at_risk: number; breached: number }>(
          `SELECT count(*)::int AS open,
             count(*) FILTER (WHERE (first_responded_at IS NULL AND first_response_at_risk_at <= $1 AND first_response_due_at >= $1) OR (resolution_at_risk_at <= $1 AND resolution_due_at >= $1))::int AS at_risk,
             count(*) FILTER (WHERE (first_responded_at IS NULL AND first_response_due_at < $1) OR resolution_due_at < $1)::int AS breached
             FROM backoffice.support_queue WHERE status IN ('open', 'awaiting_customer')`,
          [at],
        ),
        pool.query<{ active: number; due: number }>(
          `SELECT count(*)::int AS active, count(*) FILTER (WHERE ends_on - renewal_notice_days <= $1::date)::int AS due FROM backoffice.contracts WHERE status = 'active'`,
          [today],
        ),
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM backoffice.status_incidents WHERE resolved_at IS NULL AND kind = 'incident'`,
        ),
      ]);
      const ms = (iso: string) => new Date(iso).getTime();
      const t = now.getTime();
      const DAY = 86_400_000;
      const rows = tenants.rows;
      const live = rows.filter((r) => r.status !== 'deleted');
      const created = (days: number) => live.filter((r) => ms(r.created_at) >= t - days * DAY).length;
      const snap = live.filter((r) => r.computed_at);
      const times = snap.map((r) => ms(r.computed_at!)).sort((a, b) => a - b);
      const paid = (s: string | null) => s === 'active' || s === 'past_due';
      const ended = live.filter(
        (r) =>
          paid(r.billing_status) ||
          r.billing_status === 'trial_expired' ||
          r.billing_status === 'canceled' ||
          r.billing_status === 'incomplete',
      );
      const converted = ended.filter((r) => paid(r.billing_status)).length;
      const soon = t + TRIAL_ENDING_DAYS * DAY;
      const cancelledRows = rows.filter(
        (r) => r.billing_status === 'canceled' || r.status === 'closing' || r.status === 'deleted',
      );
      const cancelledAt = (r: (typeof rows)[number]) =>
        r.cancelled_at
          ? ms(r.cancelled_at)
          : r.status === 'closing' || r.status === 'deleted'
            ? ms(r.updated_at)
            : 0;
      const sum = (
        k: 'active_users_7d' | 'active_users_30d' | 'active_users' | 'users_with_mfa' | 'headcount',
      ) => live.reduce((n, r) => n + (r[k] ?? 0), 0);
      const weeks = weekStarts(today, SIGNUP_WEEKS);
      const signupCounts = weeklyCounts(
        rows.map((r) => instantToDate(new Date(r.created_at).toISOString(), 'UTC')),
        weeks,
      );
      return {
        cell,
        generatedAt: at,
        snapshot: {
          oldest: times.length ? new Date(times[0]!).toISOString() : null,
          newest: times.length ? new Date(times[times.length - 1]!).toISOString() : null,
          missing: live.length - snap.length,
        },
        companies: {
          total: live.length,
          new7d: created(7),
          new30d: created(30),
          byStatus: tally(live, (r) => r.status),
          byPlan: tally(snap, (r) => r.plan_id),
          byBillingStatus: tally(snap, (r) => r.billing_status),
        },
        signups: weeks.map((weekStart, i) => ({ weekStart, count: signupCounts[i]! })),
        trials: {
          active: live.filter((r) => r.billing_status === 'trialing').length,
          endingSoon: live.filter(
            (r) =>
              r.billing_status === 'trialing' &&
              r.trial_ends_at &&
              ms(r.trial_ends_at) >= t &&
              ms(r.trial_ends_at) <= soon,
          ).length,
          endingSoonDays: TRIAL_ENDING_DAYS,
          ended: ended.length,
          converted,
          conversionBasisPoints: conversionBasisPoints(converted, ended.length),
        },
        churn: {
          cancelled: cancelledRows.length,
          cancelled30d: cancelledRows.filter((r) => cancelledAt(r) >= t - 30 * DAY).length,
          closing: rows.filter((r) => r.status === 'closing').length,
        },
        usage: {
          activeUsers7d: sum('active_users_7d'),
          activeUsers30d: sum('active_users_30d'),
          users: sum('active_users'),
          usersWithMfa: sum('users_with_mfa'),
          employees: sum('headcount'),
        },
        revenue: recurringRevenue(
          revenue.rows.map((r): RecurringLine => ({
            currency: r.currency,
            term: r.term as RecurringLine['term'],
            intervalAmountMinor: r.amount,
          })),
        ),
        support: {
          openTickets: support.rows[0]!.open,
          slaAtRisk: support.rows[0]!.at_risk,
          slaBreached: support.rows[0]!.breached,
        },
        contracts: { active: contracts.rows[0]!.active, renewalsDue: contracts.rows[0]!.due },
        incidents: { active: incidents.rows[0]!.n },
      };
    },
  );

  app.get(
    '/v1/backoffice/metrics/global',
    {
      ...guard,
      schema: {
        tags: ['backoffice'],
        summary:
          'Companies in every region from the global tenant directory only (region, plan, status, sign-up time)',
        response: { 200: GlobalMetricsT, 401: Problem, 403: Problem },
      },
    },
    async () => {
      const now = deps.now();
      const at = now.toISOString();
      const weeks = weekStarts(instantToDate(at, 'UTC'), SIGNUP_WEEKS);
      const entries = await deps.directory.list();
      const t = now.getTime();
      const within = (days: number, iso?: string) =>
        !!iso && new Date(iso).getTime() >= t - days * 86_400_000;
      return {
        generatedAt: at,
        thisCell: deps.config.cell,
        regions: HOME_REGIONS.map((region: HomeRegion) => {
          const all = entries.filter((e) => e.homeRegion === region);
          const live = all.filter((e) => e.status !== 'deleted');
          const dates = all.filter((e) => e.createdAt).map((e) => instantToDate(e.createdAt!, 'UTC'));
          const counts = weeklyCounts(dates, weeks);
          return {
            region,
            total: live.length,
            new7d: live.filter((e) => within(7, e.createdAt)).length,
            new30d: live.filter((e) => within(30, e.createdAt)).length,
            signups: weeks.map((weekStart, i) => ({ weekStart, count: counts[i]! })),
            byPlan: tally(live, (e) => e.planRef),
            byStatus: tally(live, (e) => e.status),
            appUrl: deps.regionalAppUrls[region],
          };
        }),
      };
    },
  );
}
