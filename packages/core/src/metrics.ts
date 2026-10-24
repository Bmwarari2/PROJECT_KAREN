import { money, multiplyRatio } from './money';
import { addDays, compareDates, startOfIsoWeek, type CivilDate } from './time';

/**
 * Pure figures for the founder's console (ADR-0175, ADR-0176): recurring revenue in integer minor units,
 * weekly sign-up buckets, trial conversion and request latency histograms. No personal data passes
 * through here: only amounts, currencies, dates, counts and route patterns.
 */

// ---- recurring revenue ------------------------------------------------------------------------------------
export interface RecurringLine {
  currency: string;
  term: 'monthly' | 'annual';
  /** Amount billed per interval, in integer minor units (a string from Postgres bigint, or a safe integer). */
  intervalAmountMinor: string | number | bigint;
}
export interface RecurringRevenue {
  currency: string;
  mrrMinor: number;
  arrMinor: number;
}

function minor(v: RecurringLine['intervalAmountMinor']): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new RangeError('Amounts must be integer minor units');
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) throw new RangeError('Amounts must be integer minor units');
  return BigInt(v);
}

/**
 * MRR and ARR per currency from live paid subscription lines (the billing module prices them from the
 * billing config or the contract). ARR is exact: twelve monthly amounts or one annual amount. MRR is ARR
 * divided by twelve, rounded half up, so the two never disagree by more than rounding.
 */
export function recurringRevenue(lines: RecurringLine[]): RecurringRevenue[] {
  const arr = new Map<string, bigint>();
  for (const l of lines) {
    const amount = money(minor(l.intervalAmountMinor), l.currency);
    let yearly: bigint;
    if (l.term === 'monthly') yearly = amount.amountMinor * 12n;
    else if (l.term === 'annual') yearly = amount.amountMinor;
    else throw new RangeError(`Unknown billing term ${String(l.term)}`);
    arr.set(l.currency, (arr.get(l.currency) ?? 0n) + yearly);
  }
  return [...arr.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, a]) => {
      const mrr = multiplyRatio(money(a, currency), 1n, 12n).amountMinor;
      if (a > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Revenue total too large');
      return { currency, mrrMinor: Number(mrr), arrMinor: Number(a) };
    });
}

// ---- sign-ups by week ------------------------------------------------------------------------------------
/** The ISO-week Mondays of the last `weeks` weeks, oldest first, ending with the week of `today`. */
export function weekStarts(today: CivilDate, weeks: number): CivilDate[] {
  const current = startOfIsoWeek(today);
  return Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
}

/** Counts calendar dates into the weeks starting at `starts` (consecutive Mondays); others are ignored. */
export function weeklyCounts(dates: CivilDate[], starts: CivilDate[]): number[] {
  const out = starts.map(() => 0);
  if (!starts.length) return out;
  const end = addDays(starts[starts.length - 1]!, 7);
  for (const d of dates) {
    if (compareDates(d, starts[0]!) < 0 || compareDates(d, end) >= 0) continue;
    const i = starts.indexOf(startOfIsoWeek(d));
    if (i >= 0) out[i]!++;
  }
  return out;
}

// ---- trial conversion ------------------------------------------------------------------------------------
/** Converted trials over ended trials, in basis points rounded half up; null when no trial has ended yet. */
export function conversionBasisPoints(converted: number, ended: number): number | null {
  if (!Number.isInteger(converted) || !Number.isInteger(ended) || converted < 0 || converted > ended)
    throw new RangeError('converted must be a whole number between 0 and ended');
  if (ended === 0) return null;
  return Number((BigInt(converted) * 20000n + BigInt(ended)) / (2n * BigInt(ended)));
}

// ---- request latency -------------------------------------------------------------------------------------
/** Upper bounds (inclusive) of the latency buckets in milliseconds; one more bucket holds everything slower. */
export const HISTOGRAM_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const HISTOGRAM_SIZE = HISTOGRAM_BOUNDS_MS.length + 1;

export function bucketIndex(ms: number): number {
  const i = HISTOGRAM_BOUNDS_MS.findIndex((b) => ms <= b);
  return i === -1 ? HISTOGRAM_BOUNDS_MS.length : i;
}

export function addHistograms(a: number[], b: number[]): number[] {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * The upper bound of the bucket in which the q-quantile falls (an upper estimate, the usual reading of a
 * bucketed histogram); the overflow bucket reports the last finite bound. Null when there are no requests.
 */
export function histogramQuantile(h: number[], q: number): number | null {
  const total = h.reduce((n, v) => n + v, 0);
  if (!total) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i] ?? 0;
    if (seen >= rank && (h[i] ?? 0) > 0)
      return HISTOGRAM_BOUNDS_MS[Math.min(i, HISTOGRAM_BOUNDS_MS.length - 1)]!;
  }
  return HISTOGRAM_BOUNDS_MS.at(-1)!;
}

/**
 * The route group a request is counted under: the first path segment after the API version of the route
 * PATTERN (never the URL, so no ids, slugs or emails), or `unmatched` for requests no route matched.
 */
export function routeGroup(pattern: string | undefined): string {
  if (!pattern) return 'unmatched';
  const parts = pattern.split('/').filter(Boolean);
  const first = /^v\d+$/.test(parts[0] ?? '') ? parts[1] : parts[0];
  if (!first || first.startsWith(':') || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(first)) return 'other';
  return first.toLowerCase();
}

// ---- company health ----------------------------------------------------------------------------------------
export type HealthLevel = 'good' | 'watch' | 'risk' | 'unknown';
export type HealthReason =
  | 'closing'
  | 'suspended'
  | 'cancelled'
  | 'paymentOverdue'
  | 'inactive'
  | 'trialEnded'
  | 'awaitingPayment'
  | 'trialEndingSoon'
  | 'quiet'
  | 'supportOverdue'
  | 'noSnapshot';
export interface HealthInput {
  /** Registry status of the workspace. */
  status: string;
  /** Status of the default billing account's newest subscription (snapshot). */
  billingStatus: string | null;
  trialEndsAt: string | null;
  lastActivityAt: string | null;
  /** When the usage snapshot was taken; null when there is none yet. */
  snapshotAt: string | null;
  breachedTickets: number;
}

const RISK: HealthReason[] = ['closing', 'suspended', 'cancelled', 'paymentOverdue', 'inactive'];
export const HEALTH_TRIAL_ENDING_DAYS = 14;
export const HEALTH_QUIET_DAYS = 14;
export const HEALTH_INACTIVE_DAYS = 30;

/**
 * A simple, explainable health signal per company (ADR-0175): risk for a workspace that is closing,
 * suspended, cancelled, behind on payment or unused for a month; watch for a trial that ended or ends
 * within two weeks, a quiet fortnight or overdue support tickets; unknown without a usage snapshot.
 * The reasons come worst first, so the list can show the first one.
 */
export function companyHealth(h: HealthInput, now: string): { level: HealthLevel; reasons: HealthReason[] } {
  const t = new Date(now).getTime();
  const days = (iso: string) => (t - new Date(iso).getTime()) / 86_400_000;
  const reasons: HealthReason[] = [];
  if (h.status === 'closing' || h.status === 'deleted') reasons.push('closing');
  if (h.status === 'suspended') reasons.push('suspended');
  if (!h.snapshotAt)
    return reasons.length ? { level: 'risk', reasons } : { level: 'unknown', reasons: ['noSnapshot'] };
  if (h.billingStatus === 'canceled') reasons.push('cancelled');
  if (h.billingStatus === 'past_due') reasons.push('paymentOverdue');
  if (!h.lastActivityAt || days(h.lastActivityAt) > HEALTH_INACTIVE_DAYS) reasons.push('inactive');
  if (h.billingStatus === 'trial_expired') reasons.push('trialEnded');
  if (h.billingStatus === 'incomplete') reasons.push('awaitingPayment');
  if (
    h.billingStatus === 'trialing' &&
    h.trialEndsAt &&
    -days(h.trialEndsAt) >= 0 &&
    -days(h.trialEndsAt) <= HEALTH_TRIAL_ENDING_DAYS
  )
    reasons.push('trialEndingSoon');
  if (
    h.lastActivityAt &&
    days(h.lastActivityAt) > HEALTH_QUIET_DAYS &&
    days(h.lastActivityAt) <= HEALTH_INACTIVE_DAYS
  )
    reasons.push('quiet');
  if (h.breachedTickets > 0) reasons.push('supportOverdue');
  const level: HealthLevel = reasons.some((r) => RISK.includes(r))
    ? 'risk'
    : reasons.length
      ? 'watch'
      : 'good';
  return { level, reasons };
}
