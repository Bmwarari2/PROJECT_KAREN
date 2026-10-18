import { PRIVACY_RULE_KEYS } from './privacy-keys';

/**
 * Jurisdiction pack format. Employment rules are DATA: versioned, effective-dated, each version
 * carrying its official source URL, the date it was verified against that source and the reviewer.
 * Never hard-code a rule value in application code — look it up with resolveRule().
 */
export interface SourceRef {
  /** Official source: legislation.gov.uk, gov.uk, dol.gov, uscis.gov, eeoc.gov, state .gov, eur-lex, national government sites. */
  url: string;
  title: string;
}

export interface RuleVersion<V = unknown> {
  effectiveFrom: string; // YYYY-MM-DD inclusive
  effectiveTo: string | null; // YYYY-MM-DD exclusive; null = open-ended
  value: V;
  source: SourceRef;
  verifiedOn: string; // YYYY-MM-DD the value was checked against the source
  reviewer: string;
  notes?: string;
  /**
   * ISO 3166-2 subdivisions this version was verified for (e.g. ["GB-ENG", "GB-WLS", "GB-SCT"]). Omitted =
   * the whole jurisdiction. Required in packs that declare `subdivisions`; a lookup for a subdivision
   * not listed here does not get this version (it falls through or fails) — never silently inherited.
   */
  regions?: string[];
}

export interface Rule<V = unknown> {
  key: string; // dotted, e.g. "leave.statutory_annual_minimum"
  description: string;
  versions: RuleVersion<V>[];
}

/** Holiday date rules (evaluated per year). */
export type HolidayDateRule =
  | { type: 'fixed'; month: number; day: number }
  | { type: 'easter'; offset: number; calendar?: 'western' | 'orthodox' }
  | { type: 'nth_weekday'; month: number; weekday: number; n: number } // weekday 1=Mon..7=Sun, n=-1 last
  | { type: 'weekday_on_or_after'; month: number; day: number; weekday: number } // e.g. Midsummer Day (Sat between 20–26 Jun)
  | { type: 'one_off'; date: string }; // a single proclaimed holiday, e.g. a coronation

/** How a holiday falling on a weekend is observed. */
export type Observance = 'none' | 'uk_substitute' | 'us_federal' | 'next_monday';

export interface HolidayDefinition {
  id: string; // stable slug, e.g. "christmas-day"
  name: string; // English name (UI translates by id)
  localName?: string;
  rule: HolidayDateRule;
  observance: Observance;
  /** ISO 3166-2 subdivision codes the holiday applies to; ["*"] = whole jurisdiction. */
  regions: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  source: SourceRef;
  verifiedOn: string;
  reviewer: string;
  notes?: string;
}

export interface JurisdictionPack {
  /**
   * ISO 3166-1 alpha-2 country ("GB", "DE"), "EU" for the EU baseline, ISO 3166-2 for a state or nation
   * ("US-CA", "GB-NIR"), or a locality below it as `<ISO 3166-2>-<code>` ("US-NY-NYC").
   */
  jurisdiction: string;
  /** Parent in layered resolution: locality → state; member state → "EU"; US state → "US"; UK nation → "GB". */
  parent: string | null;
  /**
   * ISO 3166-2 subdivisions with their own law (e.g. the UK nations). When set, every rule version in
   * this pack must state the `regions` it was verified for, so a subdivision never inherits a rule by
   * accident (ADR-0022).
   */
  subdivisions?: string[];
  name: string;
  /** Pack version: bump on every data change (edits create new versions, never overwrite). */
  version: number;
  updatedOn: string;
  rules: Rule[];
  holidays: HolidayDefinition[];
  /** Coverage notes rendered into docs/COVERAGE.md. */
  coverage?: { priority: 'baseline' | 'high' | 'medium' | 'low'; deeperRulesTodo?: string[]; notes?: string };
}

/** Standard rule keys (extend as packs grow; validated so typos are caught). */
export const RULE_KEYS = {
  ...PRIVACY_RULE_KEYS,
  'leave.statutory_annual_minimum': 'Minimum paid annual leave entitlement',
  'leave.irregular_hours_accrual': 'Holiday accrual for irregular-hours / part-year workers',
  'leave.carry_over': 'Statutory carry-over of untaken leave',
  'working_time.max_weekly_hours': 'Maximum average weekly working hours',
  'working_time.daily_rest': 'Minimum daily rest',
  'working_time.weekly_rest': 'Minimum weekly rest',
  'working_time.rest_break': 'Minimum rest break during the working day',
  'working_time.opt_out': '48-hour week individual opt-out',
  'working_time.time_recording': 'Obligation to record daily working time',
  'overtime.weekly': 'Weekly overtime threshold and multiplier',
  'overtime.daily': 'Daily overtime thresholds and multipliers',
  'overtime.seventh_day': 'Seventh consecutive day premium',
  'overtime.exempt_salary_threshold': 'Minimum salary for exempt (white-collar) classification',
  'overtime.exempt_duties_tests': 'Exemption categories, duties criteria and which salary test applies',
  'sick_pay.statutory': 'Statutory sick pay parameters',
  'sick_pay.paid_sick_leave_accrual': 'Paid sick leave accrual (US state/local)',
  'family_leave.fmla': 'FMLA eligibility and entitlement',
  'family_leave.maternity': 'Statutory maternity leave',
  'family_leave.paternity': 'Statutory paternity leave',
  'right_to_work.document_rules': 'Right-to-work / work authorisation check rules',
  'right_to_work.retention': 'Retention period for right-to-work records',
  'i9.retention': 'Form I-9 retention period',
  'i9.reverification': 'Form I-9 reverification rules',
  'i9.completion_deadlines': 'Form I-9 Section 1 and Section 2 completion deadlines',
  'employment.unfair_dismissal_qualifying_period': 'Qualifying service for unfair dismissal protection',
  'employment.probation': 'Statutory probation limits',
  'employment.notice_period': 'Statutory minimum notice periods',
  'reporting.gender_pay_gap': 'Gender pay gap reporting obligation',
  'reporting.eeo1': 'EEO-1 Component 1 reporting obligation',
  'reporting.pay_transparency': 'EU Pay Transparency Directive implementation',
  'minimum_wage.rates': 'Statutory minimum wage rates',
} as const;
export type RuleKey = keyof typeof RULE_KEYS;
