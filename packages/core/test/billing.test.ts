import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BillingConfigError,
  bandFor,
  cancellationEffectiveAt,
  classifyChange,
  contactChannels,
  loadBillingConfig,
  planById,
  prorationPreview,
  quote,
  trialEndsAt,
  validateBillingConfig,
  validateContractPricing,
  type BillingConfig,
} from '../src/billing';
import { money } from '../src/money';

const cfg = loadBillingConfig('builtin:billing-config-v1');
const band = (planId: string, headcount: number) => bandFor(planById(cfg, planId)!, headcount)!;

describe('billing configuration v1', () => {
  it('is valid versioned data with prices for every band in GBP, EUR and USD', () => {
    expect(validateBillingConfig(cfg)).toEqual([]);
    expect(cfg.version).toBe(1);
    expect(cfg.currencies).toEqual(['GBP', 'EUR', 'USD']);
    for (const p of cfg.plans.filter((x) => x.selfServe)) {
      for (const b of p.bands)
        for (const c of cfg.currencies) expect(Number.isSafeInteger(b.monthlyUnit[c])).toBe(true);
    }
  });

  it('rejects broken configs (gaps between bands, floats, unknown trial plan, missing SLA)', () => {
    const broken = structuredClone(cfg) as BillingConfig;
    broken.plans[0]!.bands[1]!.minEmployees = 60;
    broken.plans[0]!.bands[0]!.monthlyUnit.GBP = 4.5;
    broken.trial.planId = 'nope';
    delete (broken.plans[1]!.support.sla as Partial<BillingConfig['plans'][0]['support']['sla']>).low;
    const problems = validateBillingConfig(broken);
    expect(problems.join('\n')).toMatch(/contiguous/);
    expect(problems.join('\n')).toMatch(/positive integer GBP price/);
    expect(problems.join('\n')).toMatch(/trial.planId/);
    expect(problems.join('\n')).toMatch(/SLA for low/);
    expect(() => loadBillingConfig('builtin:does-not-exist')).toThrow(BillingConfigError);
  });

  it('resolves contact channels per plan and region, with back-office overrides and unconfigured numbers hidden', () => {
    const core = contactChannels(cfg, 'core', 'uk', 'thapsus-hr.test');
    expect(core.map((c) => c.kind)).toEqual(['help_centre', 'ticket', 'email']);
    expect(core.find((c) => c.kind === 'email')!.value).toBe('support@thapsus-hr.test');
    // the enterprise phone number is null until a human configures it (HUMAN_TODO 4.7)
    expect(contactChannels(cfg, 'enterprise', 'us', 'x.test').some((c) => c.kind === 'phone')).toBe(false);
    const overridden = contactChannels(cfg, 'core', 'eu', 'x.test', {
      eu: { core: [{ kind: 'phone', value: '+49 30 0000000', hours: 'business_hours' }] },
    });
    expect(overridden).toEqual([{ kind: 'phone', value: '+49 30 0000000', hours: 'business_hours' }]);
    expect(contactChannels(cfg, 'core', 'uk', 'x.test', { eu: { core: [] } }).length).toBe(3);
  });
});

describe('quotes (integer minor units, from config only)', () => {
  it('prices monthly plans per billable employee by headcount band, with a minimum', () => {
    const q = quote(cfg, { planId: 'core', term: 'monthly', currency: 'GBP', headcount: 30 });
    const unit = band('core', 30).monthlyUnit.GBP;
    expect(q).toMatchObject({ quantity: 30, bandId: '1-49', interval: 'month', source: 'config' });
    expect(q.unitAmount).toEqual(money(unit, 'GBP'));
    expect(q.totalAmount.amountMinor).toBe(BigInt(unit) * 30n);
    expect(q.discountAmount.amountMinor).toBe(0n);
    const small = quote(cfg, { planId: 'core', term: 'monthly', currency: 'USD', headcount: 2 });
    expect(small.quantity).toBe(planById(cfg, 'core')!.minimumEmployees);
  });

  it('moves to the next band at the boundary (volume pricing)', () => {
    const at49 = quote(cfg, { planId: 'plus', term: 'monthly', currency: 'EUR', headcount: 49 });
    const at50 = quote(cfg, { planId: 'plus', term: 'monthly', currency: 'EUR', headcount: 50 });
    expect(at49.bandId).toBe('1-49');
    expect(at50.bandId).toBe('50-249');
    expect(at50.unitAmount.amountMinor).toBe(BigInt(band('plus', 50).monthlyUnit.EUR));
  });

  it('annual terms bill 12 months with the configured term discount, rounded half-up', () => {
    const q = quote(cfg, { planId: 'core', term: 'annual', currency: 'USD', headcount: 10 });
    const unit = BigInt(band('core', 10).monthlyUnit.USD) * 12n;
    const bp = BigInt(cfg.discounts.terms.annual);
    const expected = (unit * (10000n - bp) * 2n + 10000n) / 20000n; // half-up
    expect(q.interval).toBe('year');
    expect(q.unitAmount.amountMinor).toBe(expected);
    expect(q.listAmount.amountMinor).toBe(unit * 10n);
    expect(q.discountAmount.amountMinor).toBe(unit * 10n - expected * 10n);
    expect(q.monthlyEquivalent.amountMinor * 12n).toBeLessThanOrEqual(q.totalAmount.amountMinor + 12n);
  });

  it('applies valid discount codes only to their plans and dates', () => {
    const code = cfg.discounts.codes[0]!;
    const base = quote(cfg, { planId: 'core', term: 'monthly', currency: 'GBP', headcount: 20 });
    const disc = quote(cfg, {
      planId: 'core',
      term: 'monthly',
      currency: 'GBP',
      headcount: 20,
      discountCode: code.code.toLowerCase(),
      on: code.validFrom,
    });
    expect(disc.discountCode).toBe(code.code);
    expect(disc.unitAmount.amountMinor).toBe(
      (base.unitAmount.amountMinor * BigInt(10000 - code.basisPoints) * 2n + 10000n) / 20000n,
    );
    expect(() =>
      quote(cfg, {
        planId: 'core',
        term: 'monthly',
        currency: 'GBP',
        headcount: 20,
        discountCode: 'NOT-A-CODE',
      }),
    ).toThrow('invalidDiscountCode');
    expect(() =>
      quote(cfg, {
        planId: 'core',
        term: 'monthly',
        currency: 'GBP',
        headcount: 20,
        discountCode: code.code,
        on: '2000-01-01',
      }),
    ).toThrow('invalidDiscountCode');
  });

  it('refuses headcounts above the self-serve bands and contract-only plans without a contract', () => {
    const max = planById(cfg, 'core')!.bands.at(-1)!.maxEmployees;
    expect(() =>
      quote(cfg, { planId: 'core', term: 'monthly', currency: 'GBP', headcount: max + 1 }),
    ).toThrow('contractRequired');
    expect(() =>
      quote(cfg, { planId: 'enterprise', term: 'annual', currency: 'GBP', headcount: 500 }),
    ).toThrow('notSelfServe');
    expect(() =>
      quote(cfg, { planId: 'core', term: 'monthly', currency: 'JPY' as never, headcount: 5 }),
    ).toThrow('unsupportedCurrency');
  });

  it('uses back-office contract pricing overrides (unit, flat fee or discount) instead of the published price', () => {
    const unit = quote(cfg, {
      planId: 'core',
      term: 'monthly',
      currency: 'GBP',
      headcount: 1200,
      contract: {
        planId: 'enterprise',
        currency: 'EUR',
        term: 'annual',
        unitAmountMinor: 3456,
        minimumEmployees: 1000,
      },
    });
    expect(unit).toMatchObject({
      planId: 'enterprise',
      currency: 'EUR',
      term: 'annual',
      quantity: 1200,
      bandId: null,
      source: 'contract',
    });
    expect(unit.totalAmount.amountMinor).toBe(3456n * 1200n);
    const flat = quote(cfg, {
      planId: 'core',
      term: 'monthly',
      currency: 'GBP',
      headcount: 7000,
      contract: { planId: 'enterprise', currency: 'USD', term: 'annual', flatAmountMinor: 12345678 },
    });
    expect(flat).toMatchObject({ quantity: 1, bandId: null });
    expect(flat.totalAmount.amountMinor).toBe(12345678n);
    const discounted = quote(cfg, {
      planId: 'plus',
      term: 'annual',
      currency: 'GBP',
      headcount: 300,
      contract: { planId: 'plus', currency: 'GBP', term: 'annual', discountBasisPoints: 1000 },
    });
    const published = quote(cfg, { planId: 'plus', term: 'annual', currency: 'GBP', headcount: 300 });
    expect(discounted.unitAmount.amountMinor).toBeLessThan(published.unitAmount.amountMinor);
    expect(validateContractPricing(cfg, { planId: 'enterprise', currency: 'GBP', term: 'annual' })).toContain(
      'this plan has no published bands: set unitAmountMinor or flatAmountMinor',
    );
    expect(
      validateContractPricing(cfg, {
        planId: 'core',
        currency: 'GBP',
        term: 'annual',
        unitAmountMinor: 1,
        flatAmountMinor: 2,
      }).length,
    ).toBe(1);
    expect(
      validateContractPricing(cfg, { planId: 'core', currency: 'GBP', term: 'annual', unitAmountMinor: 1.5 }),
    ).toContain('unitAmountMinor must be a non-negative integer');
  });
});

describe('plan changes, proration and cancellation', () => {
  it('classifies upgrades (immediate) and downgrades (end of period)', () => {
    expect(
      classifyChange(cfg, { planId: 'core', term: 'monthly' }, { planId: 'plus', term: 'monthly' }),
    ).toBe('upgrade');
    expect(
      classifyChange(cfg, { planId: 'plus', term: 'monthly' }, { planId: 'core', term: 'monthly' }),
    ).toBe('downgrade');
    expect(classifyChange(cfg, { planId: 'core', term: 'monthly' }, { planId: 'core', term: 'annual' })).toBe(
      'term_upgrade',
    );
    expect(classifyChange(cfg, { planId: 'core', term: 'annual' }, { planId: 'plus', term: 'monthly' })).toBe(
      'term_downgrade',
    );
    expect(classifyChange(cfg, { planId: 'core', term: 'annual' }, { planId: 'core', term: 'annual' })).toBe(
      'none',
    );
  });

  it('prorates an immediate upgrade by the minute: credit for unused time, charge at the new price', () => {
    const p = prorationPreview({
      oldIntervalAmount: money(30_000, 'GBP'),
      newIntervalAmount: money(60_000, 'GBP'),
      periodStart: '2027-03-01T00:00:00Z',
      periodEnd: '2027-03-31T00:00:00Z',
      changeAt: '2027-03-16T00:00:00Z',
    });
    expect(p.periodMinutes).toBe(30 * 24 * 60);
    expect(p.remainingMinutes).toBe(15 * 24 * 60);
    expect(p.credit).toEqual(money(15_000, 'GBP'));
    expect(p.charge).toEqual(money(30_000, 'GBP'));
    expect(p.net).toEqual(money(15_000, 'GBP'));
    const odd = prorationPreview({
      oldIntervalAmount: money(1, 'EUR'),
      newIntervalAmount: money(2, 'EUR'),
      periodStart: '2027-01-01T00:00:00Z',
      periodEnd: '2027-01-01T00:03:00Z',
      changeAt: '2027-01-01T00:01:00Z',
    });
    expect(odd.credit.amountMinor).toBe(1n); // 2/3 of 1 → 0.67 rounds half-up to 1
    expect(() =>
      prorationPreview({
        oldIntervalAmount: money(1, 'EUR'),
        newIntervalAmount: money(1, 'USD'),
        periodStart: '2027-01-01T00:00:00Z',
        periodEnd: '2027-02-01T00:00:00Z',
        changeAt: '2027-01-02T00:00:00Z',
      }),
    ).toThrow();
  });

  it('cancels at the first period end after the notice period (monthly rolling, annual, trial)', () => {
    const notice = cfg.terms.monthly.cancellationNoticeDays;
    expect(notice).toBeGreaterThan(0);
    // notice ends after the current period end → the following period end
    expect(
      cancellationEffectiveAt(cfg, {
        term: 'monthly',
        requestedAt: '2027-05-20T10:00:00Z',
        currentPeriodEnd: '2027-06-01T00:00:00Z',
        status: 'active',
      }),
    ).toBe('2027-07-01T00:00:00Z');
    // notice ends before the period end → the current period end
    expect(
      cancellationEffectiveAt(cfg, {
        term: 'monthly',
        requestedAt: '2027-05-01T10:00:00Z',
        currentPeriodEnd: '2027-06-15T00:00:00Z',
        status: 'active',
      }),
    ).toBe('2027-06-15T00:00:00Z');
    expect(
      cancellationEffectiveAt(cfg, {
        term: 'annual',
        requestedAt: '2027-01-10T00:00:00Z',
        currentPeriodEnd: '2027-12-01T00:00:00Z',
        status: 'active',
      }),
    ).toBe('2027-12-01T00:00:00Z');
    expect(
      cancellationEffectiveAt(cfg, {
        term: 'annual',
        requestedAt: '2027-11-20T00:00:00Z',
        currentPeriodEnd: '2027-12-01T00:00:00Z',
        status: 'active',
      }),
    ).toBe('2028-12-01T00:00:00Z');
    expect(
      cancellationEffectiveAt(cfg, {
        term: 'monthly',
        requestedAt: '2027-05-20T10:00:00Z',
        currentPeriodEnd: '2027-06-01T00:00:00Z',
        trialEndsAt: '2027-05-25T00:00:00Z',
        status: 'trialing',
      }),
    ).toBe('2027-05-25T00:00:00Z');
  });

  it('trial length comes from config', () => {
    expect(trialEndsAt(cfg, '2027-02-01T12:00:00Z')).toBe(
      `2027-03-${String(1 + cfg.trial.days - 28).padStart(2, '0')}T12:00:00Z`,
    );
  });
});

/**
 * Prices, bands and discounts are never hard-coded: billing and pricing source files may not contain
 * a price-like literal. The config JSON (and back-office contract records) are the only sources.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const PRICING_SOURCES = [
  'packages/core/src/billing',
  'apps/api/src/modules/billing',
  'apps/web/app/(marketing)/pricing',
  'apps/web/app/app/billing',
  'apps/web/app/backoffice/plans',
];
const PRICE_LITERALS: Array<[string, RegExp]> = [
  ['amount/price/fee assigned a number', /\b\w*(amount|price|fee|cost|unit)\w*["']?\s*[:=]\s*-?\d{2,}/i],
  // `$1`-style SQL placeholders are not prices; a dollar amount in quotes, with cents or "per …" is.
  [
    'currency symbol followed by a number',
    /[£€]\s?\d|(?<![\w(,=\s])\$\d|\$\d+\.\d{2}\b|\$\d+\s+(per|a)\b|\bUS\$\s?\d/,
  ],
  ['currency code assigned a number', /\b(GBP|EUR|USD)["']?\s*[:=]\s*\d+/],
  ['number followed by a currency code', /\d\s*(GBP|EUR|USD)\b/],
];

function sourceFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  try {
    statSync(abs);
  } catch {
    return [];
  }
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

export function hardcodedPrices(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .flatMap((line) =>
      PRICE_LITERALS.filter(([, re]) => re.test(line)).map(([name]) => `${name}: ${line.trim()}`),
    );
}

describe('no hard-coded prices', () => {
  it('the detector catches price literals', () => {
    expect(hardcodedPrices('const unitAmountMinor = 400;')).toHaveLength(1);
    expect(hardcodedPrices('monthlyUnit: { GBP: 400 }')).not.toHaveLength(0);
    expect(hardcodedPrices('label = "From £4 per person"')).not.toHaveLength(0);
    expect(hardcodedPrices("price = '$12'")).not.toHaveLength(0);
    expect(hardcodedPrices('label = "Only $9 per seat"')).not.toHaveLength(0);
    expect(hardcodedPrices("tx.query('SELECT * FROM t WHERE id = $1 AND x = ($2, $3)')")).toEqual([]);
    expect(hardcodedPrices('const total = 500 USD')).not.toHaveLength(0);
    expect(hardcodedPrices('const q = quote(cfg, input); // amounts from config')).toEqual([]);
  });

  it('billing and pricing source files contain no price literals', () => {
    const files = PRICING_SOURCES.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(3);
    const found = files.flatMap((f) =>
      hardcodedPrices(readFileSync(f, 'utf8')).map((m) => `${relative(ROOT, f)}: ${m}`),
    );
    expect(found).toEqual([]);
  });
});
