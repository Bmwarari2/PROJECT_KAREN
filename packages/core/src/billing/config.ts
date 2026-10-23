import type { HomeRegion } from '../regions';
import configV1 from './config-v1.json' with { type: 'json' };

/**
 * Billing configuration: versioned data, never code. Prices, bands, discounts, trial length, notice
 * periods, SLA targets and contact channels are read from the JSON document named by the
 * `billingConfigLocation` setting (infra: SSM `/thapsus-hr/<env>/billing/config-location`, default
 * `builtin:billing-config-v1`). ADR-0100.
 */
export const BILLING_CURRENCIES = ['GBP', 'EUR', 'USD'] as const;
export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];
export type Term = 'monthly' | 'annual';
export const TERMS: readonly Term[] = ['monthly', 'annual'];
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export interface Band {
  id: string;
  minEmployees: number;
  maxEmployees: number;
  /** Price per billable employee per month, integer minor units per currency, excluding tax. */
  monthlyUnit: Record<BillingCurrency, number>;
}

export interface SlaTarget {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface Plan {
  id: string;
  rank: number;
  selfServe: boolean;
  providerProductName: string;
  minimumEmployees: number;
  features: string[];
  bands: Band[];
  support: { coverage: 'business_hours' | 'always'; sla: Record<Priority, SlaTarget> };
}

export interface SupportHours {
  timeZone: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday). */
  days: number[];
  start: string;
  end: string;
}

export type ContactChannelKind = 'help_centre' | 'ticket' | 'email' | 'phone' | 'chat';
export interface ContactChannel {
  kind: ContactChannelKind;
  /** Address or number; `{domain}` is replaced with the product domain. null = not yet configured (hidden). */
  value?: string | null;
  hours?: 'business_hours' | 'always';
}

export interface DiscountCode {
  code: string;
  basisPoints: number;
  plans: string[];
  validFrom: string;
  validTo: string | null;
  description: string;
}

export interface BillingConfig {
  id: string;
  version: number;
  effectiveFrom: string;
  currencies: BillingCurrency[];
  taxBehavior: 'exclusive' | 'inclusive';
  /** Stripe Tax product tax code (https://docs.stripe.com/tax/tax-codes: txcd_10103001 = SaaS, business use). */
  providerTaxCode: string;
  trial: { days: number; planId: string };
  terms: Record<Term, { interval: 'month' | 'year'; months: number; cancellationNoticeDays: number }>;
  discounts: { terms: Record<Term, number>; codes: DiscountCode[] };
  plans: Plan[];
  support: {
    atRiskPercent: number;
    hours: Record<HomeRegion, SupportHours>;
    escalationEmail: string;
    contactChannels: Record<string, ContactChannel[]>;
  };
}

export class BillingConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid billing configuration: ${problems.join('; ')}`);
    this.name = 'BillingConfigError';
  }
}

const BUILTIN: Record<string, unknown> = { 'builtin:billing-config-v1': configV1 };
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Structural and business validation; returns every problem found (empty = valid). */
export function validateBillingConfig(raw: unknown): string[] {
  const p: string[] = [];
  const c = raw as BillingConfig;
  if (!c || typeof c !== 'object') return ['config is not an object'];
  if (!isInt(c.version) || c.version < 1) p.push('version must be a positive integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.effectiveFrom ?? '')) p.push('effectiveFrom must be a date');
  if (
    !Array.isArray(c.currencies) ||
    !c.currencies.every((x) => (BILLING_CURRENCIES as readonly string[]).includes(x))
  )
    p.push('currencies must be a subset of GBP, EUR, USD');
  if (!/^txcd_\d{8}$/.test(c.providerTaxCode ?? ''))
    p.push('providerTaxCode must be a Stripe tax code (txcd_########)');
  if (!isInt(c.trial?.days) || c.trial.days < 0 || c.trial.days > 90) p.push('trial.days must be 0–90');
  for (const t of TERMS) {
    const term = c.terms?.[t];
    if (
      !term ||
      !isInt(term.months) ||
      !isInt(term.cancellationNoticeDays) ||
      term.cancellationNoticeDays < 0
    )
      p.push(`terms.${t} is invalid`);
    const d = c.discounts?.terms?.[t];
    if (!isInt(d) || d < 0 || d >= 10_000) p.push(`discounts.terms.${t} must be 0–9999 basis points`);
  }
  for (const code of c.discounts?.codes ?? []) {
    if (!/^[A-Z0-9_-]{3,32}$/.test(code.code)) p.push(`discount code ${code.code} has an invalid format`);
    if (!isInt(code.basisPoints) || code.basisPoints <= 0 || code.basisPoints >= 10_000)
      p.push(`discount code ${code.code} basisPoints must be 1–9999`);
  }
  const ids = new Set<string>();
  for (const plan of c.plans ?? []) {
    if (ids.has(plan.id)) p.push(`duplicate plan ${plan.id}`);
    ids.add(plan.id);
    if (!isInt(plan.minimumEmployees) || plan.minimumEmployees < 1)
      p.push(`plan ${plan.id} minimumEmployees must be >= 1`);
    if (plan.selfServe && !plan.bands.length) p.push(`self-serve plan ${plan.id} needs at least one band`);
    let expectedMin = 1;
    for (const b of plan.bands) {
      if (b.minEmployees !== expectedMin)
        p.push(`plan ${plan.id} band ${b.id} must start at ${expectedMin} (bands are contiguous)`);
      if (!isInt(b.maxEmployees) || b.maxEmployees < b.minEmployees)
        p.push(`plan ${plan.id} band ${b.id} has an invalid range`);
      expectedMin = b.maxEmployees + 1;
      for (const cur of c.currencies ?? []) {
        const v = b.monthlyUnit?.[cur];
        if (!isInt(v) || v <= 0)
          p.push(`plan ${plan.id} band ${b.id} needs a positive integer ${cur} price (minor units)`);
      }
    }
    for (const pr of ['urgent', 'high', 'normal', 'low'] as const) {
      const s = plan.support?.sla?.[pr];
      if (
        !s ||
        !isInt(s.firstResponseMinutes) ||
        !isInt(s.resolutionMinutes) ||
        s.firstResponseMinutes <= 0 ||
        s.resolutionMinutes < s.firstResponseMinutes
      ) {
        p.push(`plan ${plan.id} SLA for ${pr} is invalid`);
      }
    }
    if (!c.support?.contactChannels?.[plan.id]?.length) p.push(`plan ${plan.id} has no contact channels`);
  }
  if (!ids.has(c.trial?.planId)) p.push('trial.planId must name a plan');
  if (!isInt(c.support?.atRiskPercent) || c.support.atRiskPercent <= 0 || c.support.atRiskPercent >= 100)
    p.push('support.atRiskPercent must be 1–99');
  for (const r of ['uk', 'eu', 'us'] as const) {
    const h = c.support?.hours?.[r];
    if (
      !h ||
      !TIME.test(h.start) ||
      !TIME.test(h.end) ||
      h.start >= h.end ||
      !h.days?.length ||
      !h.days.every((d) => isInt(d) && d >= 1 && d <= 7)
    )
      p.push(`support.hours.${r} is invalid`);
  }
  return p;
}

const cache = new Map<string, BillingConfig>();

/** Loads and validates the billing config named by its location (throws BillingConfigError). */
export function loadBillingConfig(
  location: string = process.env.BILLING_CONFIG_LOCATION ?? 'builtin:billing-config-v1',
): BillingConfig {
  const hit = cache.get(location);
  if (hit) return hit;
  const raw = BUILTIN[location];
  if (!raw) throw new BillingConfigError([`unknown billing config location ${location}`]);
  const problems = validateBillingConfig(raw);
  if (problems.length) throw new BillingConfigError(problems);
  const cfg = Object.freeze(structuredClone(raw)) as BillingConfig;
  cache.set(location, cfg);
  return cfg;
}

export function planById(cfg: BillingConfig, id: string): Plan | undefined {
  return cfg.plans.find((p) => p.id === id);
}

export function isBillingCurrency(v: unknown): v is BillingCurrency {
  return typeof v === 'string' && (BILLING_CURRENCIES as readonly string[]).includes(v);
}

/** Contact channels for a plan in a region; back-office overrides (per region and plan) win. */
export function contactChannels(
  cfg: BillingConfig,
  planId: string,
  region: HomeRegion,
  domain: string,
  overrides?: Partial<Record<HomeRegion, Record<string, ContactChannel[]>>> | null,
): ContactChannel[] {
  const list =
    overrides?.[region]?.[planId] ??
    cfg.support.contactChannels[planId] ??
    cfg.support.contactChannels[cfg.trial.planId] ??
    [];
  return list
    .filter((ch) => ch.value !== null)
    .map((ch) => ({
      ...ch,
      ...(ch.value ? { value: ch.value.replace('{domain}', domain).replace('{region}', region) } : {}),
    }));
}

export function escalationAddress(cfg: BillingConfig, region: HomeRegion, domain: string): string {
  return cfg.support.escalationEmail.replace('{domain}', domain).replace('{region}', region);
}
