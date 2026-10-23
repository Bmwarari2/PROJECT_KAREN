import { money, multiplyRatio, type Money } from '../money';
import { Temporal, compareInstants, minutesBetween, type CivilDate, type Instant } from '../time';
import {
  planById,
  type Band,
  type BillingConfig,
  type BillingCurrency,
  type Plan,
  type Term,
} from './config';

/**
 * Pricing, proration and cancellation rules (ADR-0104). Pure functions over the billing config and
 * (for enterprise customers) the back-office contract record. Money is integer minor units (bigint).
 */

/** Price overrides from a back-office enterprise contract (ADR-0107). At most one pricing mode. */
export interface ContractPricing {
  planId: string;
  currency: BillingCurrency;
  term: Term;
  /** Per billable employee per billing interval (month or year). */
  unitAmountMinor?: number | null;
  /** Fixed fee per billing interval, independent of headcount. */
  flatAmountMinor?: number | null;
  /** Discount on the published band price, in basis points. */
  discountBasisPoints?: number | null;
  minimumEmployees?: number | null;
}

export interface QuoteInput {
  planId: string;
  term: Term;
  currency: BillingCurrency;
  /** Aggregate count of billable employees (never employee records). */
  headcount: number;
  discountCode?: string | null;
  /** Calendar date the quote applies on (discount code validity). */
  on?: CivilDate;
  contract?: ContractPricing | null;
}

export interface Quote {
  planId: string;
  term: Term;
  currency: BillingCurrency;
  interval: 'month' | 'year';
  headcount: number;
  quantity: number;
  bandId: string | null;
  /** Per billable employee per interval after discounts (or the flat fee when quantity is 1 by contract). */
  unitAmount: Money;
  /** Before discounts, per interval. */
  listAmount: Money;
  discountAmount: Money;
  /** Per interval, excluding tax. */
  totalAmount: Money;
  /** Monthly-equivalent total, for comparing terms (rounded half-up). */
  monthlyEquivalent: Money;
  discountCode: string | null;
  source: 'config' | 'contract';
  configVersion: number;
}

export class PricingError extends Error {
  constructor(
    readonly code:
      | 'unknownPlan'
      | 'notSelfServe'
      | 'contractRequired'
      | 'unsupportedCurrency'
      | 'invalidDiscountCode'
      | 'invalidHeadcount'
      | 'invalidContract',
  ) {
    super(code);
    this.name = 'PricingError';
  }
}

const BP = 10_000n;

export function bandFor(plan: Plan, headcount: number): Band | undefined {
  return plan.bands.find((b) => headcount >= b.minEmployees && headcount <= b.maxEmployees);
}

export function validateContractPricing(cfg: BillingConfig, c: ContractPricing): string[] {
  const p: string[] = [];
  if (!planById(cfg, c.planId)) p.push('unknown plan');
  if (!cfg.currencies.includes(c.currency)) p.push('unsupported currency');
  const modes = [c.unitAmountMinor, c.flatAmountMinor, c.discountBasisPoints].filter(
    (v) => v !== undefined && v !== null,
  );
  if (modes.length > 1) p.push('choose one of unitAmountMinor, flatAmountMinor or discountBasisPoints');
  for (const [k, v] of Object.entries({
    unitAmountMinor: c.unitAmountMinor,
    flatAmountMinor: c.flatAmountMinor,
    minimumEmployees: c.minimumEmployees,
  })) {
    if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v < 0))
      p.push(`${k} must be a non-negative integer`);
  }
  if (
    c.discountBasisPoints !== undefined &&
    c.discountBasisPoints !== null &&
    (!Number.isSafeInteger(c.discountBasisPoints) ||
      c.discountBasisPoints < 0 ||
      c.discountBasisPoints >= 10_000)
  )
    p.push('discountBasisPoints must be 0–9999');
  const plan = planById(cfg, c.planId);
  if (
    plan &&
    !plan.bands.length &&
    (c.unitAmountMinor ?? null) === null &&
    (c.flatAmountMinor ?? null) === null
  )
    p.push('this plan has no published bands: set unitAmountMinor or flatAmountMinor');
  return p;
}

function intervalOf(cfg: BillingConfig, term: Term) {
  return cfg.terms[term].interval;
}

/** Converts a monthly unit price to the term's billing interval, applying the configured term discount. */
function termUnit(cfg: BillingConfig, monthlyUnit: Money, term: Term): Money {
  const months = BigInt(cfg.terms[term].months);
  const discount = BigInt(cfg.discounts.terms[term]);
  return multiplyRatio(
    { amountMinor: monthlyUnit.amountMinor * months, currency: monthlyUnit.currency },
    BP - discount,
    BP,
  );
}

export function quote(cfg: BillingConfig, input: QuoteInput): Quote {
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 0)
    throw new PricingError('invalidHeadcount');
  const contract = input.contract ?? null;
  const planId = contract?.planId ?? input.planId;
  const plan = planById(cfg, planId);
  if (!plan) throw new PricingError('unknownPlan');
  const currency = contract?.currency ?? input.currency;
  const term = contract?.term ?? input.term;
  if (!cfg.currencies.includes(currency)) throw new PricingError('unsupportedCurrency');
  const interval = intervalOf(cfg, term);
  const minimum = contract?.minimumEmployees ?? plan.minimumEmployees;
  let quantity = Math.max(input.headcount, minimum);
  const band = bandFor(plan, quantity) ?? null;

  let list: Money;
  let unit: Money;
  let discountCode: string | null = null;
  if (contract) {
    if (validateContractPricing(cfg, contract).length) throw new PricingError('invalidContract');
    if (contract.flatAmountMinor !== undefined && contract.flatAmountMinor !== null) {
      quantity = 1;
      unit = money(contract.flatAmountMinor, currency);
      list = unit;
    } else if (contract.unitAmountMinor !== undefined && contract.unitAmountMinor !== null) {
      unit = money(contract.unitAmountMinor, currency);
      list = unit;
    } else {
      if (!band) throw new PricingError('contractRequired');
      list = termUnit(cfg, money(band.monthlyUnit[currency], currency), term);
      unit = multiplyRatio(list, BP - BigInt(contract.discountBasisPoints ?? 0), BP);
    }
  } else {
    if (!plan.selfServe) throw new PricingError('notSelfServe');
    if (!band) throw new PricingError('contractRequired');
    // List price per interval before the term discount, so the saving is visible.
    list = money(BigInt(band.monthlyUnit[currency]) * BigInt(cfg.terms[term].months), currency);
    unit = termUnit(cfg, money(band.monthlyUnit[currency], currency), term);
    if (input.discountCode) {
      const code = cfg.discounts.codes.find((d) => d.code === input.discountCode!.toUpperCase());
      const on = input.on ?? cfg.effectiveFrom;
      if (
        !code ||
        !code.plans.includes(plan.id) ||
        on < code.validFrom ||
        (code.validTo !== null && on > code.validTo)
      )
        throw new PricingError('invalidDiscountCode');
      unit = multiplyRatio(unit, BP - BigInt(code.basisPoints), BP);
      discountCode = code.code;
    }
  }
  const q = BigInt(quantity);
  const totalAmount = { amountMinor: unit.amountMinor * q, currency };
  const listAmount = { amountMinor: list.amountMinor * q, currency };
  const months = BigInt(cfg.terms[term].months);
  return {
    planId: plan.id,
    term,
    currency,
    interval,
    headcount: input.headcount,
    quantity,
    bandId:
      contract && (contract.flatAmountMinor ?? contract.unitAmountMinor ?? null) !== null
        ? null
        : (band?.id ?? null),
    unitAmount: unit,
    listAmount,
    discountAmount: { amountMinor: listAmount.amountMinor - totalAmount.amountMinor, currency },
    totalAmount,
    monthlyEquivalent: multiplyRatio(totalAmount, 1n, months),
    discountCode,
    source: contract ? 'contract' : 'config',
    configVersion: cfg.version,
  };
}

// ---- time helpers (UTC instants; calendar arithmetic through Temporal) -----------------------------
export function addTermToInstant(cfg: BillingConfig, at: Instant, term: Term, count = 1): Instant {
  return Temporal.Instant.from(at)
    .toZonedDateTimeISO('UTC')
    .add({ months: cfg.terms[term].months * count })
    .toInstant()
    .toString();
}

export function addDaysToInstant(at: Instant, days: number): Instant {
  return Temporal.Instant.from(at).toZonedDateTimeISO('UTC').add({ days }).toInstant().toString();
}

export function trialEndsAt(cfg: BillingConfig, signedUpAt: Instant): Instant {
  return addDaysToInstant(signedUpAt, cfg.trial.days);
}

// ---- plan changes ------------------------------------------------------------------------------------
export type ChangeKind = 'none' | 'upgrade' | 'downgrade' | 'term_upgrade' | 'term_downgrade';

/**
 * Classifies a self-serve change. Upgrades (higher plan, or monthly → annual) apply at once with
 * proration; downgrades (lower plan, or annual → monthly) apply at the end of the current period.
 */
export function classifyChange(
  cfg: BillingConfig,
  from: { planId: string; term: Term },
  to: { planId: string; term: Term },
): ChangeKind {
  const a = planById(cfg, from.planId);
  const b = planById(cfg, to.planId);
  if (!a || !b) throw new PricingError('unknownPlan');
  if (a.id === b.id && from.term === to.term) return 'none';
  // Shortening the commitment (annual → monthly) always waits for the end of the paid term.
  if (from.term === 'annual' && to.term === 'monthly') return 'term_downgrade';
  if (b.rank > a.rank) return 'upgrade';
  if (b.rank < a.rank) return 'downgrade';
  return 'term_upgrade';
}

export interface ProrationPreview {
  /** Credit for the unused part of the current period at the old price. */
  credit: Money;
  /** Charge for the rest of the period at the new price. */
  charge: Money;
  /** charge − credit (positive = amount due now, before tax). */
  net: Money;
  remainingMinutes: number;
  periodMinutes: number;
}

/**
 * Estimated proration for an immediate change inside a period, by the minute and rounded half-up.
 * Stripe computes the invoiced amount itself (by the second); this preview is shown before confirming.
 */
export function prorationPreview(o: {
  oldIntervalAmount: Money;
  newIntervalAmount: Money;
  periodStart: Instant;
  periodEnd: Instant;
  changeAt: Instant;
}): ProrationPreview {
  if (o.oldIntervalAmount.currency !== o.newIntervalAmount.currency)
    throw new PricingError('unsupportedCurrency');
  const total = minutesBetween(o.periodStart, o.periodEnd);
  const remaining = Math.max(0, Math.min(total, minutesBetween(o.changeAt, o.periodEnd)));
  const currency = o.oldIntervalAmount.currency;
  if (total <= 0)
    return {
      credit: money(0, currency),
      charge: money(0, currency),
      net: money(0, currency),
      remainingMinutes: 0,
      periodMinutes: 0,
    };
  const credit = multiplyRatio(o.oldIntervalAmount, remaining, total);
  const charge = multiplyRatio(o.newIntervalAmount, remaining, total);
  return {
    credit,
    charge,
    net: { amountMinor: charge.amountMinor - credit.amountMinor, currency },
    remainingMinutes: remaining,
    periodMinutes: total,
  };
}

/**
 * When a cancellation takes effect: the first period end on or after the end of the notice period.
 * During a trial the subscription simply ends at the trial end (nothing is charged).
 */
export function cancellationEffectiveAt(
  cfg: BillingConfig,
  o: {
    term: Term;
    requestedAt: Instant;
    currentPeriodEnd: Instant;
    trialEndsAt?: Instant | null;
    status: string;
  },
): Instant {
  if (o.status === 'trialing' && o.trialEndsAt) return o.trialEndsAt;
  const noticeEnds = addDaysToInstant(o.requestedAt, cfg.terms[o.term].cancellationNoticeDays);
  let boundary = o.currentPeriodEnd;
  for (let i = 0; compareInstants(boundary, noticeEnds) < 0; i++) {
    if (i > 1200) throw new Error('cancellation date did not converge');
    boundary = addTermToInstant(cfg, boundary, o.term);
  }
  return boundary;
}

/** JSON-safe view of a Money value (amounts here are far below 2^53). */
export function moneyJson(m: Money): { amountMinor: number; currency: string } {
  const n = Number(m.amountMinor);
  if (!Number.isSafeInteger(n)) throw new RangeError('amount exceeds the safe integer range');
  return { amountMinor: n, currency: m.currency };
}
