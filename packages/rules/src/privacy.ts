import { addDays, addMinutes, addMonths, addYears, compareDates, compareInstants, dateParts, makeDate, type CivilDate, type Instant } from '@thapsus/core/time';
import type { ResolvedRule, RuleBook } from './engine';

/**
 * Privacy and retention computations over the jurisdiction packs. The VALUES (periods, thresholds,
 * hours) always come from pack data with an official source; this module only does the date maths,
 * so every answer carries the rule version it was computed from.
 */

// ---- ISO-8601 periods (PnYnMnWnD) ---------------------------------------------------------------
const PERIOD_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;

export interface Period {
  years: number;
  months: number;
  days: number;
}

export function parsePeriod(p: string): Period {
  const m = PERIOD_RE.exec(p);
  if (!m || p === 'P') throw new RangeError(`Unsupported period ${p}`);
  return { years: Number(m[1] ?? 0), months: Number(m[2] ?? 0), days: Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0) };
}

/** Adds a period to a calendar date: years, then months (clamped to month end), then days. */
export function addPeriod(date: CivilDate, period: string): CivilDate {
  const p = parsePeriod(period);
  return addDays(addMonths(addYears(date, p.years), p.months), p.days);
}

/** True when period a is at least as long as b (compared from a common month-end reference date). */
export function periodAtLeast(a: string, b: string): boolean {
  for (const ref of ['2001-01-31', '2004-02-29', '2003-07-15']) if (compareDates(addPeriod(ref, a), addPeriod(ref, b)) < 0) return false;
  return true;
}

const earliest = (a: CivilDate, b: CivilDate) => (compareDates(a, b) <= 0 ? a : b);
const latest = (a: CivilDate, b: CivilDate) => (compareDates(a, b) >= 0 ? a : b);

export interface RuleRef {
  jurisdiction: string;
  key: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  packVersion: number;
  source: { url: string; title: string };
  verifiedOn: string;
}

export const ruleRef = (r: ResolvedRule): RuleRef => ({
  jurisdiction: r.jurisdiction,
  key: r.key,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  packVersion: r.packVersion,
  source: r.source,
  verifiedOn: r.verifiedOn,
});

/**
 * Jurisdiction used for privacy rules: a US state where known (US-CA), otherwise the country
 * (member states resolve through the EU baseline), otherwise the tenant's home-region regime.
 */
export function privacyJurisdiction(country: string | null | undefined, region: string | null | undefined, homeRegime: 'UK' | 'EU' | 'US'): string {
  const c = country?.trim().toUpperCase();
  const r = region?.trim().toUpperCase();
  if (c === 'US' && r && /^US-[A-Z]{2}$/.test(r)) return r;
  if (c && /^[A-Z]{2}$/.test(c)) return c;
  return homeRegime === 'UK' ? 'GB' : homeRegime;
}

// ---- Data subject request deadlines ---------------------------------------------------------------
export type DsrKind = 'access' | 'correction' | 'deletion';

export interface DsrDeadlineRule {
  /** Initial response period, e.g. "P1M" (UK GDPR / GDPR) or "P45D" (CCPA). */
  period: string;
  /** The clock starts at the LATEST of these events. */
  clockStartsAt: Array<'request_received' | 'information_received' | 'fee_paid'>;
  extension: { period: string; grounds: string; noticeBefore: 'initial_deadline'; reasonsRequired: boolean } | null;
  /** Time between asking for clarification and receiving it does not count (UK GDPR Art. 12A(5)). */
  clockStopForClarification: { appliesTo: DsrKind[] } | null;
  appliesTo: DsrKind[];
  /** Upper bound on the total time including extension, where the law states one. */
  maxTotal?: string;
}

export interface DsrClockInput {
  receivedOn: CivilDate;
  /** Date further information requested under the rule (e.g. identity confirmation) was received. */
  informationReceivedOn?: CivilDate | null;
  feePaidOn?: CivilDate | null;
  /** Whole days the clock was stopped while awaiting clarification. */
  pausedDays?: number;
}

export interface DsrDeadline {
  applies: boolean;
  startsOn: CivilDate;
  dueOn: CivilDate;
  /** Latest date if the deadline is extended (notice must be given by extensionNoticeBy). */
  extendedDueOn: CivilDate | null;
  extensionNoticeBy: CivilDate | null;
  rule: RuleRef;
  value: DsrDeadlineRule;
}

/**
 * Deadline for a request received on `receivedOn` under the law in force on that date. Returns
 * undefined where no data-subject-request law covers employees in the jurisdiction (e.g. US
 * federal). When dates are ambiguous the earlier (safer) deadline is returned.
 */
export function dsrDeadline(book: RuleBook, jurisdiction: string, kind: DsrKind, input: DsrClockInput): DsrDeadline | undefined {
  const r = book.tryResolve<DsrDeadlineRule>(jurisdiction, 'privacy.dsr_deadline', input.receivedOn);
  if (!r) return undefined;
  const v = r.value;
  let start = input.receivedOn;
  if (v.clockStartsAt.includes('information_received') && input.informationReceivedOn) start = latest(start, input.informationReceivedOn);
  if (v.clockStartsAt.includes('fee_paid') && input.feePaidOn) start = latest(start, input.feePaidOn);
  const paused = v.clockStopForClarification?.appliesTo.includes(kind) ? Math.max(0, input.pausedDays ?? 0) : 0;
  const due = addDays(addPeriod(start, v.period), paused);
  let extended: CivilDate | null = null;
  if (v.extension) {
    extended = addPeriod(due, v.extension.period);
    // "two further months" = three months in total from the start: take the earlier reading.
    const p = parsePeriod(v.period);
    const e = parsePeriod(v.extension.period);
    extended = earliest(extended, addDays(addPeriod(start, `P${p.years + e.years}Y${p.months + e.months}M${p.days + e.days}D`), paused));
    if (v.maxTotal) extended = earliest(extended, addDays(addPeriod(start, v.maxTotal), paused));
  }
  return { applies: v.appliesTo.includes(kind), startsOn: start, dueOn: due, extendedDueOn: extended, extensionNoticeBy: v.extension ? due : null, rule: ruleRef(r), value: v };
}

// ---- Breach notification -----------------------------------------------------------------------------
export interface BreachAudienceRule {
  /** Who is notified, e.g. "Information Commission", "California Attorney General". */
  body?: string;
  /** Fixed outer limit, where the law gives one. */
  deadlineHours?: number | null;
  deadlineDays?: number | null;
  /** What starts the clock in the statute's words: awareness, discovery, determination. */
  from?: 'awareness' | 'discovery' | 'determination' | 'consumer_notice';
  /** The qualitative standard ("without undue delay", "most expedient time possible"). */
  standard: string;
  /** Only required when at least this many residents are affected. */
  minAffected?: number | null;
  /** Condition in the statute's words (e.g. likely to result in a high risk). */
  condition?: string;
}

export interface BreachNotificationRule {
  regulator: BreachAudienceRule | null;
  individuals: BreachAudienceRule | null;
  processorToController: BreachAudienceRule | null;
  consumerReportingAgencies?: BreachAudienceRule | null;
  lawEnforcementDelay?: boolean;
  /** Fields the statute leaves unverified are listed so the UI can say "check with counsel". */
  unverified?: string[];
}

export type BreachAudience = 'regulator' | 'individuals' | 'processorToController' | 'consumerReportingAgencies';

export interface BreachDeadline {
  jurisdiction: string;
  audience: BreachAudience;
  body: string | null;
  /** Fixed outer deadline (UTC instant) where the law sets one; null when only a standard applies. */
  dueAt: Instant | null;
  standard: string;
  /** False when a threshold in the rule is not met by the affected count. */
  required: boolean;
  minAffected: number | null;
  condition: string | null;
  rule: RuleRef;
}

/**
 * Notification deadlines for a breach the organisation became aware of at `awareAt`, for every
 * jurisdiction with affected people. Hour limits run from awareness; day limits are applied as whole
 * 24-hour days from the same instant (never later than the statutory day count).
 */
export function breachDeadlines(book: RuleBook, awareAt: Instant, affected: Record<string, number>): BreachDeadline[] {
  const out: BreachDeadline[] = [];
  const onDate = awareAt.slice(0, 10);
  for (const [jurisdiction, count] of Object.entries(affected)) {
    const r = book.tryResolve<BreachNotificationRule>(jurisdiction, 'privacy.breach_notification', onDate);
    if (!r) continue;
    for (const audience of ['regulator', 'individuals', 'processorToController', 'consumerReportingAgencies'] as const) {
      const a = r.value[audience];
      if (!a) continue;
      const minutes = a.deadlineHours ? a.deadlineHours * 60 : a.deadlineDays ? a.deadlineDays * 24 * 60 : null;
      out.push({
        jurisdiction,
        audience,
        body: a.body ?? null,
        dueAt: minutes === null ? null : addMinutes(awareAt, minutes),
        standard: a.standard,
        required: a.minAffected ? count >= a.minAffected : true,
        minAffected: a.minAffected ?? null,
        condition: a.condition ?? null,
        rule: ruleRef(r),
      });
    }
  }
  return out.sort((x, y) => (x.dueAt && y.dueAt ? compareInstants(x.dueAt, y.dueAt) : x.dueAt ? -1 : y.dueAt ? 1 : 0));
}

// ---- Retention -----------------------------------------------------------------------------------------------
/** Product data categories the retention engine manages. */
export const RETENTION_CATEGORIES = ['time_records', 'leave_records', 'sickness_records', 'payroll_records', 'immigration_records', 'personnel_records', 'notifications'] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/** Which pack rules govern each category (rules for other categories are never consulted). */
export const RETENTION_RULE_KEYS: Record<RetentionCategory, string[]> = {
  time_records: ['retention.time_records'],
  leave_records: ['retention.leave_records'],
  sickness_records: ['retention.leave_records'],
  payroll_records: ['retention.payroll_records', 'retention.minimum_wage_records'],
  immigration_records: ['right_to_work.retention', 'i9.retention'],
  personnel_records: ['retention.personnel_records'],
  notifications: [],
};

export type RetentionAnchor = 'record_date' | 'end_of_tax_year' | 'employment_end' | 'later_of_record_and_employment_end' | 'end_of_following_pay_reference_period';

export interface RetentionRuleValue {
  period: string;
  from: RetentionAnchor;
  /** True when the law sets a MINIMUM: tenants cannot shorten it. False = suggested default only. */
  statutoryMinimum: boolean;
  legalReview: 'pending' | 'reviewed';
  /** For end_of_tax_year: the tax year end as MM-DD. */
  taxYearEnd?: string;
  /** Some laws add a period after a later event (e.g. US 29 CFR 1602.14 involuntary termination). */
  afterEmploymentEnds?: string;
}

export interface RetentionAnchors {
  recordDate: CivilDate;
  employmentEnd?: CivilDate | null;
  /** Length of the pay reference period that follows the record (defaults to one month). */
  payReferencePeriod?: string;
}

export interface NormalisedRetention {
  key: string;
  value: RetentionRuleValue;
  rule: RuleRef;
}

/** Retention rules for a category in a jurisdiction on a date, normalised from their pack shapes. */
export function retentionRules(book: RuleBook, jurisdiction: string, category: RetentionCategory, onDate: CivilDate): NormalisedRetention[] {
  const out: NormalisedRetention[] = [];
  for (const key of RETENTION_RULE_KEYS[category]) {
    const r = book.tryResolve<Record<string, unknown>>(jurisdiction, key, onDate);
    if (!r) continue;
    const v = r.value;
    let value: RetentionRuleValue | undefined;
    if (key === 'right_to_work.retention' && typeof v.retainAfterEmploymentEnds === 'string') {
      value = { period: v.retainAfterEmploymentEnds, from: 'employment_end', statutoryMinimum: true, legalReview: 'pending' };
    } else if (key === 'i9.retention' && v.rule === 'later_of') {
      value = { period: `P${Number(v.afterHireYears)}Y`, from: 'later_of_record_and_employment_end', afterEmploymentEnds: `P${Number(v.afterEmploymentEndsYears)}Y`, statutoryMinimum: true, legalReview: 'pending' };
    } else if (typeof v.period === 'string' && typeof v.from === 'string') {
      value = v as unknown as RetentionRuleValue;
    }
    if (value) out.push({ key, value, rule: ruleRef(r) });
  }
  return out;
}

function taxYearEndOnOrAfter(date: CivilDate, mmdd: string): CivilDate {
  const [mm, dd] = mmdd.split('-').map(Number) as [number, number];
  const { year } = dateParts(date);
  const sameYear = makeDate(year, mm, dd);
  return compareDates(sameYear, date) >= 0 ? sameYear : makeDate(year + 1, mm, dd);
}

/**
 * Earliest date the record may be deleted under one rule, or null when it must be kept (the
 * employment has not ended yet and the rule runs from the end of employment).
 */
export function retainUntil(v: RetentionRuleValue, a: RetentionAnchors): CivilDate | null {
  switch (v.from) {
    case 'record_date':
      return addPeriod(a.recordDate, v.period);
    case 'end_of_tax_year':
      return addPeriod(taxYearEndOnOrAfter(a.recordDate, v.taxYearEnd ?? '04-05'), v.period);
    case 'end_of_following_pay_reference_period':
      return addPeriod(addPeriod(a.recordDate, a.payReferencePeriod ?? 'P1M'), v.period);
    case 'employment_end':
      return a.employmentEnd ? addPeriod(a.employmentEnd, v.period) : null;
    case 'later_of_record_and_employment_end': {
      // For Form I-9 the "record" is the hire (callers pass the first day of employment as recordDate).
      const fromRecord = addPeriod(a.recordDate, v.period);
      if (!v.afterEmploymentEnds) return fromRecord;
      if (!a.employmentEnd) return null;
      return latest(fromRecord, addPeriod(a.employmentEnd, v.afterEmploymentEnds));
    }
  }
}

export interface RetentionDecision {
  /** Date from which the record may be deleted; null = keep (statutory clock not started). */
  deletableFrom: CivilDate | null;
  /** The statutory minimum applies (tenant policy cannot shorten it). */
  statutory: boolean;
  rules: NormalisedRetention[];
}

/**
 * Combines every rule for the category (latest date wins) with the tenant's own period, which can
 * lengthen but never shorten a statutory minimum. Without any rule or tenant period the record is kept.
 */
export function retentionDecision(rules: NormalisedRetention[], anchors: RetentionAnchors, tenant?: { period: string; from: RetentionAnchor } | null): RetentionDecision {
  let until: CivilDate | null | undefined;
  let statutory = false;
  for (const r of rules) {
    const d = retainUntil(r.value, anchors);
    if (r.value.statutoryMinimum) statutory = true;
    if (d === null) return { deletableFrom: null, statutory, rules };
    if (r.value.statutoryMinimum || !tenant) until = until ? latest(until, d) : d;
  }
  if (tenant) {
    const d = retainUntil({ period: tenant.period, from: tenant.from, statutoryMinimum: false, legalReview: 'pending' }, anchors);
    if (d === null) return { deletableFrom: null, statutory, rules };
    until = until ? latest(until, d) : d;
  }
  return { deletableFrom: until ?? null, statutory, rules };
}
