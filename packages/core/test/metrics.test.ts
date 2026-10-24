import { describe, expect, it } from 'vitest';
import {
  HISTOGRAM_BOUNDS_MS,
  addHistograms,
  bucketIndex,
  companyHealth,
  conversionBasisPoints,
  histogramQuantile,
  recurringRevenue,
  routeGroup,
  weekStarts,
  weeklyCounts,
} from '../src/metrics';

describe('recurring revenue (integer minor units per currency)', () => {
  it('counts monthly lines as MRR and twelve months of ARR; annual lines as ARR and a rounded twelfth of MRR', () => {
    const out = recurringRevenue([
      { currency: 'GBP', term: 'monthly', intervalAmountMinor: '4500' },
      { currency: 'GBP', term: 'annual', intervalAmountMinor: '100000' },
      { currency: 'EUR', term: 'monthly', intervalAmountMinor: 999 },
    ]);
    // GBP ARR = 4500 × 12 + 100000 = 154000; MRR = 154000 / 12 = 12833.33… → 12833
    expect(out).toEqual([
      { currency: 'EUR', mrrMinor: 999, arrMinor: 11988 },
      { currency: 'GBP', mrrMinor: 12833, arrMinor: 154000 },
    ]);
  });

  it('rounds half up and never uses floating point for large totals', () => {
    // 6 / 12 = 0.5 → 1
    expect(recurringRevenue([{ currency: 'USD', term: 'annual', intervalAmountMinor: '6' }])).toEqual([
      { currency: 'USD', mrrMinor: 1, arrMinor: 6 },
    ]);
    const big = recurringRevenue([
      { currency: 'USD', term: 'annual', intervalAmountMinor: '900719925474099' },
      { currency: 'USD', term: 'annual', intervalAmountMinor: '900719925474099' },
    ]);
    expect(big[0]!.arrMinor).toBe(1801439850948198);
  });

  it('refuses amounts that are not integer minor units and unknown terms', () => {
    expect(() =>
      recurringRevenue([{ currency: 'GBP', term: 'monthly', intervalAmountMinor: '12.5' }]),
    ).toThrow();
    expect(() =>
      recurringRevenue([{ currency: 'GBP', term: 'weekly' as 'monthly', intervalAmountMinor: '1' }]),
    ).toThrow();
    expect(() =>
      recurringRevenue([{ currency: 'gbp', term: 'monthly', intervalAmountMinor: '1' }]),
    ).toThrow();
  });

  it('returns nothing for no paid lines', () => {
    expect(recurringRevenue([])).toEqual([]);
  });
});

describe('weekly sign-ups (ISO weeks, calendar dates in UTC)', () => {
  it('lists the Mondays of the last n weeks, oldest first, ending with the current week', () => {
    // 2026-10-24 is a Saturday; its ISO week starts on Monday 2026-10-19
    expect(weekStarts('2026-10-24', 3)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    expect(weekStarts('2026-10-19', 1)).toEqual(['2026-10-19']);
  });

  it('counts dates into their week and ignores dates outside the range', () => {
    const weeks = weekStarts('2026-10-24', 2); // 2026-10-12, 2026-10-19
    expect(
      weeklyCounts(
        ['2026-10-12', '2026-10-18', '2026-10-19', '2026-10-25', '2026-10-26', '2026-10-01'],
        weeks,
      ),
    ).toEqual([2, 2]);
  });

  it('crosses a year boundary', () => {
    expect(weekStarts('2027-01-02', 2)).toEqual(['2026-12-21', '2026-12-28']);
  });
});

describe('trial conversion', () => {
  it('is converted over ended trials in basis points (rounded half up), null when no trial has ended', () => {
    expect(conversionBasisPoints(1, 3)).toBe(3333);
    expect(conversionBasisPoints(2, 3)).toBe(6667);
    expect(conversionBasisPoints(0, 4)).toBe(0);
    expect(conversionBasisPoints(0, 0)).toBeNull();
    expect(() => conversionBasisPoints(5, 4)).toThrow();
  });
});

describe('latency histograms', () => {
  it('puts a duration in the first bucket whose bound it does not exceed, with an overflow bucket', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(HISTOGRAM_BOUNDS_MS[0]!)).toBe(0);
    expect(bucketIndex(HISTOGRAM_BOUNDS_MS[0]! + 0.1)).toBe(1);
    expect(bucketIndex(1e9)).toBe(HISTOGRAM_BOUNDS_MS.length);
  });

  it('estimates a quantile as the upper bound of the bucket that reaches it', () => {
    const h = new Array(HISTOGRAM_BOUNDS_MS.length + 1).fill(0);
    h[bucketIndex(20)] = 90; // 90 fast requests
    h[bucketIndex(400)] = 10; // 10 slow ones
    expect(histogramQuantile(h, 0.5)).toBe(25);
    expect(histogramQuantile(h, 0.95)).toBe(500);
    expect(histogramQuantile(new Array(h.length).fill(0), 0.95)).toBeNull();
    // the overflow bucket has no upper bound: report the last finite bound
    const slow = new Array(h.length).fill(0);
    slow[slow.length - 1] = 1;
    expect(histogramQuantile(slow, 0.5)).toBe(HISTOGRAM_BOUNDS_MS.at(-1));
  });

  it('adds histograms element by element', () => {
    expect(addHistograms([1, 2, 3], [0, 5])).toEqual([1, 7, 3]);
  });
});

describe('route groups never carry ids or personal data', () => {
  it('takes the first segment after the version from the route pattern', () => {
    expect(routeGroup('/v1/employees/:id')).toBe('employees');
    expect(routeGroup('/v1/backoffice/tenants/:tenantId')).toBe('backoffice');
    expect(routeGroup('/scim/v2/Users/:id')).toBe('scim');
    expect(routeGroup('/health')).toBe('health');
    expect(routeGroup('/v1/leave/requests')).toBe('leave');
    expect(routeGroup(undefined)).toBe('unmatched');
    expect(routeGroup('/v1/:weird')).toBe('other');
    expect(routeGroup('/')).toBe('other');
  });
});

describe('company health (a simple signal for the companies list)', () => {
  const now = '2026-10-24T12:00:00.000Z';
  const base = {
    status: 'active',
    billingStatus: 'active',
    trialEndsAt: null,
    lastActivityAt: '2026-10-23T09:00:00.000Z',
    snapshotAt: '2026-10-24T01:00:00.000Z',
    breachedTickets: 0,
  };
  it('is good for an active, paying, recently used workspace', () => {
    expect(companyHealth(base, now)).toEqual({ level: 'good', reasons: [] });
  });
  it('watches trials ending within 14 days, quiet workspaces and overdue support tickets', () => {
    expect(
      companyHealth({ ...base, billingStatus: 'trialing', trialEndsAt: '2026-11-01T00:00:00.000Z' }, now),
    ).toEqual({ level: 'watch', reasons: ['trialEndingSoon'] });
    expect(
      companyHealth({ ...base, billingStatus: 'trialing', trialEndsAt: '2026-11-20T00:00:00.000Z' }, now),
    ).toEqual({ level: 'good', reasons: [] });
    expect(companyHealth({ ...base, lastActivityAt: '2026-10-05T00:00:00.000Z' }, now)).toEqual({
      level: 'watch',
      reasons: ['quiet'],
    });
    expect(companyHealth({ ...base, breachedTickets: 2 }, now).reasons).toEqual(['supportOverdue']);
  });
  it('flags risk for overdue payment, cancellation, closing and a month without activity, worst first', () => {
    expect(companyHealth({ ...base, billingStatus: 'past_due' }, now)).toEqual({
      level: 'risk',
      reasons: ['paymentOverdue'],
    });
    expect(
      companyHealth({ ...base, billingStatus: 'canceled', lastActivityAt: '2026-08-01T00:00:00.000Z' }, now),
    ).toEqual({ level: 'risk', reasons: ['cancelled', 'inactive'] });
    expect(companyHealth({ ...base, status: 'closing' }, now).reasons).toEqual(['closing']);
    expect(companyHealth({ ...base, lastActivityAt: null }, now).reasons).toEqual(['inactive']);
    expect(companyHealth({ ...base, billingStatus: 'trial_expired' }, now)).toEqual({
      level: 'watch',
      reasons: ['trialEnded'],
    });
  });
  it('is unknown without a usage snapshot', () => {
    expect(companyHealth({ ...base, snapshotAt: null }, now)).toEqual({
      level: 'unknown',
      reasons: ['noSnapshot'],
    });
  });
});
