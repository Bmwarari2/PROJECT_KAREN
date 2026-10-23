import {
  addDays,
  addMonths,
  compareDates,
  dateParts,
  dayOfWeek,
  daysBetween,
  makeDate,
  maxDate,
  minDate,
} from '@thapsus/core/time';
import type { ResolvedRule, RuleBook } from '@thapsus/rules';
import { gpgDates } from '../../modules/compliance/engine';
import { FIRST_NAMES, LAST_NAMES, prng } from '../fixtures';
import type { LoginRole } from './config';

/**
 * The fictional staging company "Kestrel Fictional Group Ltd" as a deterministic plan: legal entities,
 * locations, departments and a roster of people with effective-dated job and pay history. Pure (no I/O):
 * the same seed, roster size and anchor date always give the same plan, and the unit tests check its
 * invariants (sizes, manager tree, pay at or above the minimum wage from the jurisdiction packs).
 *
 * Everything is invented: names come from the fictional fixtures, phone numbers from the ranges Ofcom and
 * the North American Numbering Plan reserve for drama, email domains are `.example.test`, postcodes use
 * areas that do not exist (ZZ, X00, 000xx). Employment rule values (minimum wage, statutory leave, …) come
 * from the jurisdiction packs; the remaining numbers (salaries, notice periods, review dates) are this
 * fictional company's own policy.
 */
export const SEED = 20261023;
/** Current staff on the full-size roster. */
export const FULL_SIZE = 300;

export type EntityKey = 'uk' | 'ie' | 'us';
export type LocationKey = 'LON' | 'MAN' | 'EDI' | 'DUB' | 'NYC';
export type DeptKey =
  | 'leadership'
  | 'engineering'
  | 'product'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'people'
  | 'support'
  | 'operations'
  | 'logistics'
  | 'legal';
export type ShiftKind =
  'rotating' | 'nights' | 'transport' | 'goods_in' | 'inventory' | 'us_support' | 'us_office';
export type WorkPattern = Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>;
export type Currency = 'GBP' | 'EUR' | 'USD';

export interface PlanEntity {
  key: EntityKey;
  name: string;
  country: string;
  regionCode: string;
  currency: Currency;
  timeZone: string;
  registrationNumber: string;
  address: Address;
}
export interface PlanLocation {
  key: LocationKey;
  name: string;
  entity: EntityKey;
  country: string;
  regionCode: string;
  timeZone: string;
  address: Address;
}
export interface Address {
  line1: string;
  city: string;
  postcode: string;
  country: string;
}

export const ENTITIES: PlanEntity[] = [
  {
    key: 'uk',
    name: 'Kestrel Fictional Group Ltd',
    country: 'GB',
    regionCode: 'GB-ENG',
    currency: 'GBP',
    timeZone: 'Europe/London',
    registrationNumber: '00000000',
    address: { line1: '1 Specimen Square', city: 'London', postcode: 'ZZ1 1AA', country: 'GB' },
  },
  {
    key: 'ie',
    name: 'Kestrel Fictional Ireland Ltd',
    country: 'IE',
    regionCode: 'IE',
    currency: 'EUR',
    timeZone: 'Europe/Dublin',
    registrationNumber: 'IE000000',
    address: { line1: '2 Placeholder Quay', city: 'Dublin', postcode: 'X00 Z000', country: 'IE' },
  },
  {
    key: 'us',
    name: 'Kestrel Fictional Inc.',
    country: 'US',
    regionCode: 'US-NY',
    currency: 'USD',
    timeZone: 'America/New_York',
    registrationNumber: '00-0000000',
    address: { line1: '3 Sample Avenue', city: 'New York', postcode: '00001', country: 'US' },
  },
];

export const LOCATIONS: PlanLocation[] = [
  {
    key: 'LON',
    name: 'London head office',
    entity: 'uk',
    country: 'GB',
    regionCode: 'GB-ENG',
    timeZone: 'Europe/London',
    address: ENTITIES[0]!.address,
  },
  {
    key: 'MAN',
    name: 'Manchester distribution centre',
    entity: 'uk',
    country: 'GB',
    regionCode: 'GB-ENG',
    timeZone: 'Europe/London',
    address: { line1: '4 Fixture Way', city: 'Manchester', postcode: 'ZZ4 4AA', country: 'GB' },
  },
  {
    key: 'EDI',
    name: 'Edinburgh support centre',
    entity: 'uk',
    country: 'GB',
    regionCode: 'GB-SCT',
    timeZone: 'Europe/London',
    address: { line1: '5 Mockridge Close', city: 'Edinburgh', postcode: 'ZZ5 5AA', country: 'GB' },
  },
  {
    key: 'DUB',
    name: 'Dublin office',
    entity: 'ie',
    country: 'IE',
    regionCode: 'IE',
    timeZone: 'Europe/Dublin',
    address: ENTITIES[1]!.address,
  },
  {
    key: 'NYC',
    name: 'New York office',
    entity: 'us',
    country: 'US',
    regionCode: 'US-NY',
    timeZone: 'America/New_York',
    address: ENTITIES[2]!.address,
  },
];

export const DEPARTMENTS: Array<{ key: DeptKey; name: string; code: string; parent?: DeptKey }> = [
  { key: 'leadership', name: 'Leadership', code: 'LDR' },
  { key: 'operations', name: 'Operations', code: 'OPS' },
  { key: 'logistics', name: 'Logistics', code: 'LOG', parent: 'operations' },
  { key: 'engineering', name: 'Engineering', code: 'ENG' },
  { key: 'product', name: 'Product and design', code: 'PRD' },
  { key: 'sales', name: 'Sales', code: 'SAL' },
  { key: 'marketing', name: 'Marketing', code: 'MKT' },
  { key: 'finance', name: 'Finance', code: 'FIN' },
  { key: 'people', name: 'People', code: 'PPL' },
  { key: 'support', name: 'Customer support', code: 'SUP', parent: 'operations' },
  { key: 'legal', name: 'Legal', code: 'LGL' },
];

// ---- organisation chart ---------------------------------------------------------------------------------

interface ExecSpec {
  key: string;
  title: string;
  dept: DeptKey;
  loc: LocationKey;
  /** First day (absolute, so the chart does not drift with the anchor date). */
  start: string;
}
const EXECS: ExecSpec[] = [
  { key: 'ceo', title: 'Chief executive officer', dept: 'leadership', loc: 'LON', start: '2012-03-05' },
  { key: 'coo', title: 'Chief operating officer', dept: 'operations', loc: 'LON', start: '2012-09-03' },
  { key: 'cto', title: 'Chief technology officer', dept: 'engineering', loc: 'LON', start: '2013-01-07' },
  { key: 'cpo', title: 'Chief product officer', dept: 'product', loc: 'LON', start: '2015-04-13' },
  { key: 'cro', title: 'Sales director', dept: 'sales', loc: 'LON', start: '2013-06-03' },
  { key: 'cmo', title: 'Marketing director', dept: 'marketing', loc: 'LON', start: '2016-02-01' },
  { key: 'cfo', title: 'Chief financial officer', dept: 'finance', loc: 'LON', start: '2014-05-06' },
  { key: 'chro', title: 'Chief people officer', dept: 'people', loc: 'LON', start: '2015-09-07' },
  { key: 'cso', title: 'Head of customer support', dept: 'support', loc: 'EDI', start: '2014-10-06' },
  { key: 'ie_md', title: 'Managing director, Ireland', dept: 'sales', loc: 'DUB', start: '2019-01-07' },
  {
    key: 'us_gm',
    title: 'General manager, United States',
    dept: 'operations',
    loc: 'NYC',
    start: '2024-03-04',
  },
];

interface TeamSpec {
  key: string;
  /** Exec or team key the lead (or, without a lead, every member) reports to. */
  parent: string;
  dept: DeptKey;
  loc: LocationKey;
  /** Lead title; null = the members report straight to the parent. */
  lead: string | null;
  /** Earliest first day of the lead (and therefore of the team). */
  since: string;
  members: Array<[title: string, count: number]>;
  shift?: ShiftKind;
  /** Kept at full size whatever the roster size (the manager login's team). */
  fixed?: boolean;
  /** The lead was promoted from this member title on this date (effective-dated job and pay change). */
  promotedFrom?: [title: string, on: string];
}
const TEAMS: TeamSpec[] = [
  // Manchester distribution centre (hourly shift workers)
  {
    key: 'logistics',
    parent: 'coo',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Head of logistics',
    since: '2014-03-03',
    members: [
      ['Logistics coordinator', 2],
      ['Health and safety advisor', 1],
    ],
  },
  {
    key: 'wh_a',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Warehouse team leader',
    since: '2019-05-13',
    members: [
      ['Warehouse operative', 6],
      ['Forklift driver', 2],
    ],
    shift: 'rotating',
    fixed: true,
    promotedFrom: ['Warehouse operative', '2023-06-01'],
  },
  {
    key: 'wh_b',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Warehouse team leader',
    since: '2016-08-01',
    members: [
      ['Warehouse operative', 10],
      ['Forklift driver', 2],
    ],
    shift: 'rotating',
  },
  {
    key: 'wh_c',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Night shift team leader',
    since: '2017-02-06',
    members: [
      ['Warehouse operative', 10],
      ['Forklift driver', 2],
    ],
    shift: 'nights',
  },
  {
    key: 'transport',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Transport team leader',
    since: '2015-11-02',
    members: [['Delivery driver', 10]],
    shift: 'transport',
  },
  {
    key: 'goods_in',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Goods-in team leader',
    since: '2018-04-09',
    members: [['Goods-in operative', 9]],
    shift: 'goods_in',
  },
  {
    key: 'inventory',
    parent: 'logistics',
    dept: 'logistics',
    loc: 'MAN',
    lead: 'Inventory team leader',
    since: '2018-09-03',
    members: [['Inventory controller', 9]],
    shift: 'inventory',
  },
  // London head office
  {
    key: 'ceo_office',
    parent: 'ceo',
    dept: 'leadership',
    loc: 'LON',
    lead: null,
    since: '2016-01-04',
    members: [['Executive assistant', 2]],
  },
  {
    key: 'platform',
    parent: 'cto',
    dept: 'engineering',
    loc: 'LON',
    lead: 'Engineering manager',
    since: '2014-02-03',
    members: [
      ['Senior software engineer', 3],
      ['Software engineer', 7],
    ],
  },
  {
    key: 'web',
    parent: 'cto',
    dept: 'engineering',
    loc: 'LON',
    lead: 'Engineering manager',
    since: '2016-06-06',
    members: [
      ['Senior software engineer', 3],
      ['Software engineer', 7],
    ],
  },
  {
    key: 'data',
    parent: 'cto',
    dept: 'engineering',
    loc: 'LON',
    lead: 'Data engineering manager',
    since: '2018-01-08',
    members: [
      ['Data engineer', 3],
      ['Data analyst', 3],
    ],
  },
  {
    key: 'security',
    parent: 'cto',
    dept: 'engineering',
    loc: 'LON',
    lead: 'Security engineering manager',
    since: '2020-03-02',
    members: [['Security engineer', 5]],
  },
  {
    key: 'product',
    parent: 'cpo',
    dept: 'product',
    loc: 'LON',
    lead: 'Head of product',
    since: '2016-03-07',
    members: [
      ['Product manager', 6],
      ['Associate product manager', 2],
    ],
  },
  {
    key: 'design',
    parent: 'cpo',
    dept: 'product',
    loc: 'LON',
    lead: 'Design lead',
    since: '2017-05-08',
    members: [
      ['Product designer', 5],
      ['Content designer', 1],
    ],
  },
  {
    key: 'sales_new',
    parent: 'cro',
    dept: 'sales',
    loc: 'LON',
    lead: 'Sales manager',
    since: '2014-09-01',
    members: [['Account executive', 12]],
  },
  {
    key: 'sales_acc',
    parent: 'cro',
    dept: 'sales',
    loc: 'LON',
    lead: 'Account management lead',
    since: '2015-07-06',
    members: [['Account manager', 10]],
  },
  {
    key: 'sales_ops',
    parent: 'cro',
    dept: 'sales',
    loc: 'LON',
    lead: 'Sales operations lead',
    since: '2019-10-07',
    members: [['Sales operations analyst', 3]],
  },
  {
    key: 'marketing',
    parent: 'cmo',
    dept: 'marketing',
    loc: 'LON',
    lead: 'Marketing manager',
    since: '2016-04-04',
    members: [
      ['Marketing executive', 5],
      ['Content designer', 2],
      ['Brand designer', 2],
    ],
  },
  {
    key: 'growth',
    parent: 'cmo',
    dept: 'marketing',
    loc: 'LON',
    lead: 'Growth lead',
    since: '2020-01-06',
    members: [['Growth marketer', 4]],
  },
  {
    key: 'finance',
    parent: 'cfo',
    dept: 'finance',
    loc: 'LON',
    lead: 'Finance manager',
    since: '2014-08-04',
    members: [
      ['Finance analyst', 5],
      ['Accounts payable clerk', 3],
    ],
  },
  {
    key: 'payroll',
    parent: 'cfo',
    dept: 'finance',
    loc: 'LON',
    lead: 'Payroll manager',
    since: '2016-10-03',
    members: [['Payroll specialist', 3]],
  },
  {
    key: 'hr',
    parent: 'chro',
    dept: 'people',
    loc: 'LON',
    lead: 'Head of people operations',
    since: '2016-01-11',
    members: [
      ['HR business partner', 3],
      ['HR advisor', 2],
      ['HR coordinator', 1],
    ],
  },
  {
    key: 'talent',
    parent: 'chro',
    dept: 'people',
    loc: 'LON',
    lead: 'Talent acquisition lead',
    since: '2018-03-05',
    members: [['Recruiter', 5]],
  },
  {
    key: 'office',
    parent: 'chro',
    dept: 'people',
    loc: 'LON',
    lead: 'Office manager',
    since: '2015-02-02',
    members: [
      ['Receptionist', 2],
      ['Facilities coordinator', 2],
    ],
  },
  {
    key: 'support_lon',
    parent: 'cso',
    dept: 'support',
    loc: 'LON',
    lead: 'Support team leader',
    since: '2015-05-05',
    members: [['Customer support specialist', 14]],
  },
  {
    key: 'ops_lon',
    parent: 'coo',
    dept: 'operations',
    loc: 'LON',
    lead: 'Operations manager',
    since: '2015-03-02',
    members: [
      ['Operations coordinator', 4],
      ['Procurement specialist', 2],
    ],
  },
  {
    key: 'legal',
    parent: 'ceo',
    dept: 'legal',
    loc: 'LON',
    lead: 'General counsel',
    since: '2017-09-04',
    members: [
      ['Legal counsel', 1],
      ['Paralegal', 1],
    ],
  },
  // Edinburgh support centre (Scotland)
  {
    key: 'support_edi_1',
    parent: 'cso',
    dept: 'support',
    loc: 'EDI',
    lead: 'Support team leader',
    since: '2015-01-12',
    members: [['Customer support specialist', 12]],
  },
  {
    key: 'support_edi_2',
    parent: 'cso',
    dept: 'support',
    loc: 'EDI',
    lead: 'Support team leader',
    since: '2018-06-04',
    members: [
      ['Customer support specialist', 8],
      ['Support quality analyst', 2],
    ],
  },
  {
    key: 'mobile',
    parent: 'cto',
    dept: 'engineering',
    loc: 'EDI',
    lead: 'Mobile engineering manager',
    since: '2019-02-04',
    members: [['Mobile engineer', 6]],
  },
  // Ireland
  {
    key: 'ie_office',
    parent: 'ie_md',
    dept: 'sales',
    loc: 'DUB',
    lead: null,
    since: '2019-03-04',
    members: [
      ['Office coordinator', 1],
      ['Customer success manager', 1],
    ],
  },
  {
    key: 'ie_sales',
    parent: 'ie_md',
    dept: 'sales',
    loc: 'DUB',
    lead: 'Sales manager, Ireland',
    since: '2019-02-04',
    members: [['Account executive', 9]],
  },
  {
    key: 'ie_support',
    parent: 'ie_md',
    dept: 'support',
    loc: 'DUB',
    lead: 'Support team leader, Ireland',
    since: '2019-06-03',
    members: [['Customer support specialist', 8]],
  },
  // United States (New York)
  {
    key: 'us_office',
    parent: 'us_gm',
    dept: 'operations',
    loc: 'NYC',
    lead: null,
    since: '2024-04-01',
    members: [
      ['HR generalist', 1],
      ['Office administrator', 1],
    ],
  },
  {
    key: 'us_sales',
    parent: 'us_gm',
    dept: 'sales',
    loc: 'NYC',
    lead: 'Sales manager, United States',
    since: '2024-03-18',
    members: [['Account executive', 6]],
  },
  {
    key: 'us_support',
    parent: 'us_gm',
    dept: 'support',
    loc: 'NYC',
    lead: 'Support team leader, United States',
    since: '2024-04-08',
    members: [['Customer support specialist', 5]],
    shift: 'us_support',
  },
];

/** Smallest roster with every team: executives, every team lead, the manager's full team and one per other line. */
export const MIN_ROSTER =
  EXECS.length +
  TEAMS.reduce(
    (a, t) => a + (t.lead ? 1 : 0) + (t.fixed ? t.members.reduce((s, [, n]) => s + n, 0) : t.members.length),
    0,
  );

/** Which person each login is linked to: an exec, a team's lead, or a member (by index) of a team. */
const LOGIN_SEATS: Record<LoginRole, { exec?: string; team?: string; member?: number }> = {
  owner: { exec: 'ceo' },
  hr_admin: { team: 'hr' },
  payroll_admin: { team: 'payroll' },
  manager: { team: 'wh_a' },
  employee: { team: 'wh_a', member: 0 },
};

// ---- pay structure (company policy; minimum wage and thresholds come from the packs) -----------------------

/** Annual salary in whole pounds by job title (UK). Ireland and US salaries are converted by a policy factor. */
const SALARY_GBP: Record<string, number> = {
  'Chief executive officer': 185000,
  'Chief operating officer': 145000,
  'Chief technology officer': 150000,
  'Chief financial officer': 145000,
  'Chief product officer': 135000,
  'Chief people officer': 125000,
  'Sales director': 120000,
  'Marketing director': 110000,
  'Head of customer support': 90000,
  'Managing director, Ireland': 115000,
  'General manager, United States': 150000,
  'Head of logistics': 75000,
  'Warehouse team leader': 41000,
  'Night shift team leader': 43000,
  'Transport team leader': 42000,
  'Goods-in team leader': 39000,
  'Inventory team leader': 39000,
  'Logistics coordinator': 31000,
  'Health and safety advisor': 38000,
  'Executive assistant': 40000,
  'Engineering manager': 95000,
  'Data engineering manager': 92000,
  'Security engineering manager': 95000,
  'Mobile engineering manager': 88000,
  'Senior software engineer': 78000,
  'Software engineer': 60000,
  'Junior software engineer': 42000,
  'Data engineer': 64000,
  'Data analyst': 48000,
  'Security engineer': 70000,
  'Mobile engineer': 60000,
  'Head of product': 90000,
  'Design lead': 80000,
  'Product manager': 66000,
  'Associate product manager': 45000,
  'Product designer': 54000,
  'Content designer': 42000,
  'Sales manager': 75000,
  'Account management lead': 70000,
  'Sales operations lead': 60000,
  'Account executive': 38000,
  'Account manager': 44000,
  'Sales operations analyst': 38000,
  'Marketing manager': 65000,
  'Growth lead': 65000,
  'Marketing executive': 32000,
  'Brand designer': 40000,
  'Growth marketer': 44000,
  'Finance manager': 70000,
  'Payroll manager': 60000,
  'Finance analyst': 44000,
  'Accounts payable clerk': 29000,
  'Payroll specialist': 35000,
  'Head of people operations': 75000,
  'HR business partner': 54000,
  'HR advisor': 38000,
  'HR coordinator': 29000,
  'Talent acquisition lead': 60000,
  Recruiter: 39000,
  'Office manager': 42000,
  Receptionist: 26500,
  'Facilities coordinator': 28500,
  'Support team leader': 40000,
  'Customer support specialist': 27500,
  'Customer support associate': 26500,
  'Support quality analyst': 32000,
  'Operations manager': 55000,
  'Operations coordinator': 30000,
  'Procurement specialist': 37000,
  'General counsel': 115000,
  'Legal counsel': 82000,
  Paralegal: 34000,
  'Office coordinator': 34000,
  'Customer success manager': 52000,
  'Sales manager, Ireland': 78000,
  'Support team leader, Ireland': 45000,
  'HR generalist': 62000,
  'Sales manager, United States': 98000,
  'Support team leader, United States': 64000,
};
/** Hourly roles: premium in minor units over the minimum wage in force on each pay date (from the packs). */
const HOURLY_PREMIUM: Record<string, [min: number, max: number]> = {
  'Warehouse operative': [40, 120],
  'Forklift driver': [150, 220],
  'Delivery driver': [200, 300],
  'Goods-in operative': [50, 110],
  'Inventory controller': [90, 160],
  'Customer support specialist': [350, 550], // US hourly (non-exempt) support
  'Office administrator': [300, 450],
};
/** Company pay-structure factors for salaries outside the UK (policy, not law). */
const FX_POLICY: Record<Currency, number> = { GBP: 1, EUR: 1.15, USD: 1.3 };
/** Pay reviews take effect on 1 April each year (company policy). */
const REVIEW_MONTH_DAY = '04-01';
const REVIEW_UPLIFT = 1.03;

const PROMOTED_FROM: Record<string, string> = {
  'Senior software engineer': 'Software engineer',
  'Software engineer': 'Junior software engineer',
  'Account manager': 'Account executive',
  'HR business partner': 'HR advisor',
  'Product manager': 'Associate product manager',
  'Finance analyst': 'Accounts payable clerk',
  'Customer support specialist': 'Customer support associate',
  'Forklift driver': 'Warehouse operative',
};

// ---- people -------------------------------------------------------------------------------------------

export interface JobRecord {
  from: string;
  title: string;
  location: LocationKey;
  employmentType: 'full_time' | 'part_time' | 'casual';
  fte: number;
  weeklyHours: number | null;
  pattern: WorkPattern | null;
  hourly: boolean;
  reason?: string;
}
export interface PayRecord {
  from: string;
  amountMinor: number;
  frequency: 'annual' | 'hourly';
  reason?: string;
}
export interface PlanPerson {
  idx: number;
  number: string;
  first: string;
  last: string;
  preferred: string | null;
  pronouns: string | null;
  /** Sex recorded for statutory pay reporting (vault); null = not recorded. */
  sex: 'female' | 'male' | null;
  dateOfBirth: string;
  nationality: string;
  personalEmail: string;
  personalPhone: string;
  address: Address;
  workEmail: string;
  workPhone: string | null;
  entity: EntityKey;
  dept: DeptKey;
  team: string;
  level: 'exec' | 'lead' | 'member';
  managerIdx: number | null;
  kind: 'roster' | 'past_leaver' | 'upcoming_starter';
  startDate: string;
  endDate: string | null;
  leaverType: 'voluntary' | 'involuntary' | null;
  leaverReason: string | null;
  recentStarter: boolean;
  shift: ShiftKind | null;
  casual: boolean;
  flsa: 'exempt' | 'non_exempt' | null;
  currency: Currency;
  jobs: JobRecord[];
  pay: PayRecord[];
  contract: { type: 'permanent' | 'fixed_term' | 'zero_hours'; noticeDays: number; probationEnd: string };
  /** Bonus paid in the 12 months to the UK gender pay gap snapshot date (minor units). */
  bonus12mMinor: number;
  login: LoginRole | null;
  emergency: Array<{ name: string; relationship: string; phone: string }>;
  tShirt: 'S' | 'M' | 'L' | 'XL' | null;
  parking: boolean | null;
  optOut: boolean;
}

export interface FutureChange {
  personIdx: number;
  effectiveDate: string;
  kind: 'promotion' | 'transfer' | 'hours';
  job?: Partial<Omit<JobRecord, 'from'>>;
  payAmountMinor?: number;
  managerIdx?: number;
  reason: string;
}

export interface Plan {
  anchor: string;
  size: number;
  people: PlanPerson[];
  logins: Record<LoginRole, number>;
  futureChanges: FutureChange[];
  /** The first day of next month and of the month after (future-dated changes). */
  nextMonth: string;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const between = (r: () => number, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const weekday = (d: string) => {
  const w = dayOfWeek(d);
  return w === 6 ? addDays(d, 2) : w === 7 ? addDays(d, 1) : d;
};
const randomDate = (r: () => number, from: string, to: string) =>
  compareDates(to, from) <= 0 ? from : weekday(addDays(from, Math.floor(r() * daysBetween(from, to))));
const roundTo = (minor: number, step: number) => Math.round(minor / step) * step;

/** The rule in force on `date`, or for dates before the pack's first version, that first version. */
export function ruleAtOrFirst<V>(
  book: RuleBook,
  jurisdiction: string,
  key: string,
  date: string,
): ResolvedRule<V> {
  const hit = book.tryResolve<V>(jurisdiction, key, date);
  if (hit) return hit;
  const firsts = book
    .chain(jurisdiction)
    .flatMap((j) => book.versions(j, key).map((v) => v.effectiveFrom))
    .sort();
  if (!firsts.length) return book.resolve<V>(jurisdiction, key, date); // throws RuleNotFoundError
  return book.resolve<V>(jurisdiction, key, firsts[0]!);
}

/** Minimum hourly wage (minor units) for adult workers on `date`, from the jurisdiction packs. */
export function minimumWageMinor(book: RuleBook, loc: LocationKey, date: string): number {
  if (loc === 'NYC') {
    const r = ruleAtOrFirst<{ rates: Array<{ region: string; hourlyMinor: number }> }>(
      book,
      'US-NY',
      'minimum_wage.rates',
      date,
    );
    return (r.value.rates.find((x) => x.region === 'nyc') ?? r.value.rates[0]!).hourlyMinor;
  }
  const r = ruleAtOrFirst<{ hourly: { age21Plus: { amountMinor: number } } }>(
    book,
    'GB',
    'minimum_wage.rates',
    date,
  );
  return r.value.hourly.age21Plus.amountMinor;
}

const FULL_PATTERN = (h: number): WorkPattern => ({ 1: h, 2: h, 3: h, 4: h, 5: h, 6: 0, 7: 0 });
const PART_PATTERNS: Array<{ pattern: WorkPattern; fte: number }> = [
  { pattern: { 1: 7.5, 2: 7.5, 3: 7.5, 4: 0, 5: 0, 6: 0, 7: 0 }, fte: 0.6 },
  { pattern: { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 0, 6: 0, 7: 0 }, fte: 0.8 },
  { pattern: { 1: 0, 2: 7.5, 3: 7.5, 4: 7.5, 5: 0, 6: 0, 7: 0 }, fte: 0.6 },
];
const weekly = (p: WorkPattern) => Object.values(p).reduce((a, b) => a + b, 0);

const FEMALE_SHARE: Record<DeptKey, number> = {
  leadership: 0.35,
  engineering: 0.2,
  product: 0.45,
  sales: 0.4,
  marketing: 0.65,
  finance: 0.55,
  people: 0.8,
  support: 0.75,
  operations: 0.5,
  logistics: 0.45,
  legal: 0.5,
};
const UK_NATIONALITIES = [
  ...Array(16).fill('GB'),
  'IE',
  'PL',
  'ES',
  'FR',
  'IT',
  'RO',
  'PT',
  'IN',
  'NG',
  'AU',
] as string[];
const RELATIONSHIPS = ['Partner', 'Spouse', 'Parent', 'Sibling', 'Friend', 'Adult child'];

function phoneFor(loc: LocationKey, n: number, mobile = true) {
  const k = String(n % 1000).padStart(3, '0');
  // Ofcom drama ranges (07700 900000–900999, 020 7946 0000–0999, 0161 496 0000–0999, 0131 496 0000–0999)
  // and the NANP fictional range 555-0100–0199.
  if (loc === 'NYC') return `+1 212 555 01${String(n % 100).padStart(2, '0')}`;
  if (mobile) return `+44 7700 900${k}`;
  if (loc === 'MAN') return `+44 161 496 0${k}`;
  if (loc === 'EDI') return `+44 131 496 0${k}`;
  return `+44 20 7946 0${k}`;
}

function homeAddress(r: () => number, loc: LocationKey, n: number): Address {
  const streets = [
    'Specimen Road',
    'Fixture Lane',
    'Mockridge Avenue',
    'Sample Street',
    'Placeholder Row',
    'Draftly Gardens',
  ];
  const city = { LON: 'London', MAN: 'Manchester', EDI: 'Edinburgh', DUB: 'Dublin', NYC: 'New York' }[loc];
  const country = { LON: 'GB', MAN: 'GB', EDI: 'GB', DUB: 'IE', NYC: 'US' }[loc];
  const postcode =
    loc === 'DUB'
      ? `X${String(n % 100).padStart(2, '0')} Z${String(n % 1000).padStart(3, '0')}`
      : loc === 'NYC'
        ? `000${String(n % 100).padStart(2, '0')}`
        : `ZZ${1 + (n % 9)} ${1 + (n % 9)}${pick(r, ['AA', 'AB', 'BA', 'BB'])}`;
  return { line1: `${1 + Math.floor(r() * 180)} ${pick(r, streets)}`, city, postcode, country };
}

interface Seat {
  team: TeamSpec | null;
  exec: ExecSpec | null;
  level: PlanPerson['level'];
  title: string;
  managerSeat: number | null;
  memberIndex: number;
  kind: PlanPerson['kind'];
  startOverride?: string;
  endDate?: string;
  leaverType?: 'voluntary' | 'involuntary';
  leaverReason?: string;
  recentStarter?: boolean;
}

/** Builds the deterministic plan for a roster of `size` people (current staff) on `anchor` (today). */
export function buildPlan(opts: { book: RuleBook; anchor: string; size?: number; seed?: number }): Plan {
  const { book, anchor } = opts;
  const size = opts.size ?? FULL_SIZE;
  const r = prng(opts.seed ?? SEED);

  // ---- seats: execs, team leads, members (scaled to the roster size) ----
  const full =
    TEAMS.reduce((a, t) => a + (t.lead ? 1 : 0) + t.members.reduce((s, [, n]) => s + n, 0), 0) + EXECS.length;
  const fixed =
    EXECS.length +
    TEAMS.reduce(
      (a, t) => a + (t.lead ? 1 : 0) + (t.fixed ? t.members.reduce((s, [, n]) => s + n, 0) : 0),
      0,
    );
  const scalable = full - fixed;
  const factor = Math.max(0, Math.min(1, (size - fixed) / scalable));
  const seats: Seat[] = [];
  const execSeat = new Map<string, number>();
  const leadSeat = new Map<string, number>();
  for (const e of EXECS) {
    execSeat.set(e.key, seats.length);
    seats.push({
      team: null,
      exec: e,
      level: 'exec',
      title: e.title,
      managerSeat: e.key === 'ceo' ? null : 0,
      memberIndex: 0,
      kind: 'roster',
    });
  }
  const parentSeat = (key: string) => execSeat.get(key) ?? leadSeat.get(key) ?? 0;
  for (const t of TEAMS) {
    if (t.lead) {
      leadSeat.set(t.key, seats.length);
      seats.push({
        team: t,
        exec: null,
        level: 'lead',
        title: t.lead,
        managerSeat: parentSeat(t.parent),
        memberIndex: 0,
        kind: 'roster',
      });
    } else leadSeat.set(t.key, parentSeat(t.parent));
  }
  // scale member counts so the roster has exactly `size` current people
  const memberCounts = TEAMS.map((t) =>
    t.members.map(([, n]) => (t.fixed ? n : Math.max(1, Math.round(n * factor)))),
  );
  let total = seats.length + memberCounts.flat().reduce((a, b) => a + b, 0);
  for (let guard = 0; total !== size && guard < 1000; guard++) {
    // add to / remove from the largest scalable member lines, deterministically
    const lines = TEAMS.flatMap((t, ti) => t.members.map((_, mi) => ({ ti, mi, fixed: !!t.fixed })))
      .filter((l) => !l.fixed)
      .sort((a, b) => memberCounts[b.ti]![b.mi]! - memberCounts[a.ti]![a.mi]! || a.ti - b.ti || a.mi - b.mi);
    const l = total < size ? lines[guard % lines.length]! : lines.find((x) => memberCounts[x.ti]![x.mi]! > 1);
    if (!l) break;
    memberCounts[l.ti]![l.mi]! += total < size ? 1 : -1;
    total += total < size ? 1 : -1;
  }
  for (const [ti, t] of TEAMS.entries()) {
    let k = 0;
    for (const [mi, [title]] of t.members.entries())
      for (let j = 0; j < memberCounts[ti]![mi]!; j++)
        seats.push({
          team: t,
          exec: null,
          level: 'member',
          title,
          managerSeat: leadSeat.get(t.key)!,
          memberIndex: k++,
          kind: 'roster',
        });
  }
  const rosterSize = seats.length;

  // recent starters and upcoming leavers among current staff
  const seatOf = (team: string, title: string, nth = 0) =>
    seats.findIndex(
      (s, i) =>
        s.team?.key === team &&
        s.level === 'member' &&
        s.title === title &&
        seats.slice(0, i).filter((x) => x.team?.key === team && x.level === 'member' && x.title === title)
          .length === nth,
    );
  const mark = (i: number, patch: Partial<Seat>) => {
    if (i >= 0) Object.assign(seats[i]!, patch);
  };
  // the employee login has a couple of years of history (absolute date, like the rest of the roster)
  mark(seatOf('wh_a', 'Warehouse operative', 0), { startOverride: '2024-02-12' });
  mark(seatOf('wh_a', 'Warehouse operative', 5), {
    recentStarter: true,
    startOverride: weekday(addDays(anchor, -18)),
  });
  mark(seatOf('sales_new', 'Account executive', 0), {
    recentStarter: true,
    startOverride: weekday(addDays(anchor, -25)),
  });
  mark(seatOf('hr', 'HR coordinator', 0), {
    recentStarter: true,
    startOverride: weekday(addDays(anchor, -32)),
  });
  mark(seatOf('support_lon', 'Customer support specialist', 0), {
    recentStarter: true,
    startOverride: weekday(addDays(anchor, -12)),
  });
  mark(seatOf('growth', 'Growth marketer', 0), {
    endDate: addDays(anchor, 18),
    leaverType: 'voluntary',
    leaverReason: 'Resigned: new role elsewhere',
  });
  mark(seatOf('wh_c', 'Warehouse operative', 1), {
    endDate: addDays(anchor, 40),
    leaverType: 'voluntary',
    leaverReason: 'Resigned: relocating',
  });

  // past leavers and upcoming starters (in addition to the roster)
  const extra: Array<
    [
      team: string,
      title: string,
      kind: Seat['kind'],
      startOrEnd: number,
      type?: Seat['leaverType'],
      reason?: string,
    ]
  > = [
    ['platform', 'Software engineer', 'past_leaver', -300, 'voluntary', 'Resigned: career change'],
    ['sales_new', 'Account executive', 'past_leaver', -210, 'voluntary', 'Resigned: new role elsewhere'],
    ['wh_b', 'Warehouse operative', 'past_leaver', -150, 'involuntary', 'Dismissed: conduct'],
    [
      'support_edi_1',
      'Customer support specialist',
      'past_leaver',
      -95,
      'voluntary',
      'Resigned: returning to study',
    ],
    ['marketing', 'Marketing executive', 'past_leaver', -60, 'voluntary', 'Resigned: new role elsewhere'],
    ['wh_a', 'Warehouse operative', 'past_leaver', -45, 'involuntary', 'End of probation'],
    ['ie_support', 'Customer support specialist', 'past_leaver', -120, 'voluntary', 'Resigned: relocating'],
    ['us_sales', 'Account executive', 'past_leaver', -30, 'voluntary', 'Resigned: new role elsewhere'],
    ['platform', 'Software engineer', 'upcoming_starter', 7],
    ['wh_b', 'Warehouse operative', 'upcoming_starter', 14],
    ['support_edi_2', 'Customer support specialist', 'upcoming_starter', 21],
    ['us_sales', 'Account executive', 'upcoming_starter', 28],
    ['ie_sales', 'Account executive', 'upcoming_starter', 35],
  ];
  for (const [team, title, kind, days, type, reason] of extra) {
    const t = TEAMS.find((x) => x.key === team)!;
    seats.push({
      team: t,
      exec: null,
      level: 'member',
      title,
      managerSeat: leadSeat.get(team)!,
      memberIndex: 99,
      kind,
      ...(kind === 'upcoming_starter'
        ? { startOverride: weekday(addDays(anchor, days)) }
        : { endDate: weekday(addDays(anchor, days)), leaverType: type, leaverReason: reason }),
    });
  }

  // ---- names (unique full names from the fictional fixtures) ----
  const combos: Array<[string, string]> = [];
  for (const f of FIRST_NAMES) for (const l of LAST_NAMES) combos.push([f, l]);
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [combos[i], combos[j]] = [combos[j]!, combos[i]!];
  }

  // ---- people ----
  const gpgRule = ruleAtOrFirst<Parameters<typeof gpgDates>[0]>(
    book,
    'GB',
    'reporting.gender_pay_gap',
    anchor,
  ).value;
  const { year: anchorYear } = dateParts(anchor);
  let gpgSnapshot = gpgDates(gpgRule, anchorYear, 'privateAndVoluntary').snapshotDate;
  if (compareDates(gpgSnapshot, anchor) > 0)
    gpgSnapshot = gpgDates(gpgRule, anchorYear - 1, 'privateAndVoluntary').snapshotDate;
  const people: PlanPerson[] = [];
  const leadSince = new Map<number, string>(); // seat → the date they started leading
  const reviewDates = [2025, 2026]
    .map((y) => `${y}-${REVIEW_MONTH_DAY}`)
    .filter((d) => compareDates(d, anchor) <= 0);
  for (const [i, s] of seats.entries()) {
    const pr = prng((opts.seed ?? SEED) + 7919 * (i + 1));
    const [first, last] = combos[i % combos.length]!;
    const t = s.team;
    const loc: LocationKey = s.exec?.loc ?? t!.loc;
    const entity: EntityKey = loc === 'DUB' ? 'ie' : loc === 'NYC' ? 'us' : 'uk';
    const dept: DeptKey = s.exec?.dept ?? t!.dept;
    const currency = ENTITIES.find((e) => e.key === entity)!.currency;
    const mgr = s.managerSeat;
    const mgrStart = mgr === null ? '2012-01-01' : (leadSince.get(mgr) ?? people[mgr]!.startDate);
    // ---- dates ----
    let start: string;
    if (s.exec) start = s.exec.start;
    else if (s.level === 'lead')
      start = t!.promotedFrom ? t!.since : maxDate(t!.since, addDays(mgrStart, 30));
    else if (s.startOverride) start = s.startOverride;
    else {
      const earliest = maxDate(addDays(mgrStart, 14), t!.since);
      const latestOffset =
        s.kind === 'past_leaver' ? Math.min(-200, daysBetween(anchor, s.endDate!) - 120) : -60;
      // UK staff (other than the recent joiners) were already employed on the last gender pay gap
      // snapshot date, so the UK entity's relevant headcount is above the threshold
      const latest =
        entity === 'uk' && s.kind === 'roster'
          ? minDate(addDays(anchor, latestOffset), addDays(gpgSnapshot, -1))
          : addDays(anchor, latestOffset);
      start = randomDate(pr, earliest, maxDate(earliest, latest));
    }
    if (s.level === 'lead') leadSince.set(i, t!.promotedFrom ? t!.promotedFrom[1] : start);
    // ---- job ----
    const shift = s.level === 'member' && t?.shift ? t.shift : null;
    const hourlyTitle = !!HOURLY_PREMIUM[s.title] && (loc === 'MAN' || loc === 'NYC') && s.level === 'member';
    const usOfficeHourly = s.title === 'Office administrator';
    const casual =
      t?.key === 'wh_b' &&
      s.level === 'member' &&
      s.title === 'Warehouse operative' &&
      s.memberIndex >= 6 &&
      s.memberIndex < 10 &&
      s.kind === 'roster';
    const partTime = !hourlyTitle && s.level === 'member' && s.kind === 'roster' && pr() < 0.1;
    const usHours = loc === 'NYC' ? 8 : 7.5;
    let job: JobRecord;
    if (casual)
      job = {
        from: start,
        title: s.title,
        location: loc,
        employmentType: 'casual',
        fte: 0.5,
        weeklyHours: null,
        pattern: null,
        hourly: true,
      };
    else if (partTime) {
      const p = pick(pr, PART_PATTERNS);
      job = {
        from: start,
        title: s.title,
        location: loc,
        employmentType: 'part_time',
        fte: p.fte,
        weeklyHours: weekly(p.pattern),
        pattern: p.pattern,
        hourly: false,
      };
    } else {
      const pattern = FULL_PATTERN(usOfficeHourly ? 7.5 : usHours);
      job = {
        from: start,
        title: s.title,
        location: loc,
        employmentType: 'full_time',
        fte: 1,
        weeklyHours: weekly(pattern),
        pattern,
        hourly: hourlyTitle || usOfficeHourly,
      };
    }
    const jobs: JobRecord[] = [job];
    // promotions: team leads promoted from the floor, and some long-serving members
    if (s.level === 'lead' && t!.promotedFrom) {
      const [fromTitle, on] = t!.promotedFrom;
      jobs[0] = { ...job, title: fromTitle, hourly: !!HOURLY_PREMIUM[fromTitle] };
      jobs.push({ ...job, from: on, title: s.title, hourly: false, reason: 'Promotion' });
    } else if (
      s.level === 'member' &&
      PROMOTED_FROM[s.title] &&
      s.kind === 'roster' &&
      !s.startOverride &&
      compareDates(start, '2023-06-01') < 0 &&
      pr() < 0.3
    ) {
      const on = pick(pr, ['2024-10-01', '2025-04-01']);
      const fromTitle = PROMOTED_FROM[s.title]!;
      jobs[0] = { ...job, title: fromTitle, hourly: job.hourly && !!HOURLY_PREMIUM[fromTitle] };
      jobs.push({ ...job, from: on, reason: 'Promotion' });
    }
    // one London engineer moved down from Edinburgh
    if (t?.key === 'web' && s.memberIndex === 1 && compareDates(start, '2023-01-02') < 0) {
      jobs[0] = { ...jobs[0]!, location: 'EDI' };
      if (jobs.length === 1) jobs.push({ ...job, from: '2023-01-02', location: 'LON', reason: 'Relocation' });
    }
    // ---- pay ----
    const personFactor = 0.94 + pr() * 0.12;
    const premiums = new Map<string, number>();
    const premiumFor = (title: string) => {
      if (!premiums.has(title)) {
        const [lo, hi] = HOURLY_PREMIUM[title] ?? [40, 90];
        premiums.set(title, between(pr, lo, hi));
      }
      return premiums.get(title)!;
    };
    const titleAt = (d: string) => [...jobs].reverse().find((j) => compareDates(j.from, d) <= 0) ?? jobs[0]!;
    const payDates = [
      ...new Set([
        start,
        ...jobs.slice(1).map((j) => j.from),
        ...reviewDates.filter((d) => compareDates(d, addMonths(start, 3)) > 0),
      ]),
    ]
      .filter((d) => !s.endDate || compareDates(d, s.endDate) <= 0)
      .sort();
    const pay: PayRecord[] = payDates.map((d) => {
      const j = titleAt(d);
      if (j.hourly) {
        return {
          from: d,
          amountMinor: minimumWageMinor(book, j.location, d) + premiumFor(j.title),
          frequency: 'hourly' as const,
          reason:
            d === start
              ? 'Starting rate'
              : jobs.some((x) => x.from === d && x !== jobs[0])
                ? 'Promotion'
                : 'Annual pay review',
        };
      }
      const reviewsAfter = reviewDates.filter((x) => compareDates(x, d) > 0).length;
      const base = (SALARY_GBP[j.title] ?? 35000) * 100 * FX_POLICY[currency] * personFactor;
      // never below the minimum wage in force on the date for the contracted hours (5% margin, whole £100)
      const floor =
        entity === 'ie'
          ? 0
          : Math.ceil((minimumWageMinor(book, j.location, d) * (j.weeklyHours ?? 37.5) * 52 * 1.05) / 10000) *
            10000;
      return {
        from: d,
        amountMinor: Math.max(floor, roundTo(base / REVIEW_UPLIFT ** reviewsAfter, 10000)),
        frequency: 'annual' as const,
        reason:
          d === start
            ? 'Starting salary'
            : jobs.some((x) => x.from === d && x !== jobs[0])
              ? (jobs.find((x) => x.from === d)!.reason ?? 'Change')
              : 'Annual pay review',
      };
    });
    // ---- personal ----
    const sexRoll = pr();
    // fewer women in senior roles, as in most UK gender pay gap reports
    const femaleShare = FEMALE_SHARE[dept] * (s.level === 'member' ? 1 : 0.55);
    const sex: PlanPerson['sex'] = sexRoll < 0.03 ? null : pr() < femaleShare ? 'female' : 'male';
    const ageAtStart =
      s.level === 'exec'
        ? between(pr, 36, 48)
        : s.level === 'lead'
          ? between(pr, 28, 42)
          : between(pr, 21, 45);
    const { year: sy } = dateParts(start);
    const dateOfBirth = makeDate(sy - ageAtStart, between(pr, 1, 12), between(pr, 1, 28));
    const nationality =
      entity === 'ie'
        ? pick(pr, ['IE', 'IE', 'IE', 'GB', 'FR', 'ES'])
        : entity === 'us'
          ? pick(pr, ['US', 'US', 'US', 'US', 'IN', 'CA'])
          : pick(pr, UK_NATIONALITIES);
    const preferred = pr() < 0.08 ? first.slice(0, Math.max(3, first.length - 1)) : null;
    const pronouns =
      pr() < 0.35 ? (sex === 'female' ? 'she/her' : sex === 'male' ? 'he/him' : 'they/them') : null;
    const emergency = Array.from({ length: pr() < 0.3 ? 2 : 1 }, (_, k) => {
      const [ef, el] = combos[(i * 7 + 400 + k * 13) % combos.length]!;
      return {
        name: `${ef} ${el}`,
        relationship: pick(pr, RELATIONSHIPS),
        phone: phoneFor(loc, i * 3 + k + 1),
      };
    });
    const login =
      (
        Object.entries(LOGIN_SEATS) as Array<[LoginRole, { exec?: string; team?: string; member?: number }]>
      ).find(
        ([, seat]) =>
          s.kind === 'roster' &&
          ((seat.exec && s.exec?.key === seat.exec) ||
            (seat.team &&
              t?.key === seat.team &&
              (seat.member === undefined
                ? s.level === 'lead'
                : s.level === 'member' && s.memberIndex === seat.member))),
      )?.[0] ?? null;
    const exempt =
      entity === 'us'
        ? s.level !== 'member' || s.title === 'HR generalist'
          ? 'exempt'
          : 'non_exempt'
        : null;
    const bonus =
      s.kind === 'upcoming_starter' || compareDates(start, '2026-04-05') > 0
        ? 0
        : ['sales'].includes(dept) && !job.hourly
          ? roundTo((pay.at(-1)!.amountMinor * between(pr, 8, 18)) / 100, 100)
          : s.level !== 'member'
            ? roundTo((pay.at(-1)!.amountMinor * between(pr, 5, 15)) / 100, 100)
            : job.hourly
              ? pr() < 0.2
                ? 15000
                : 0
              : pr() < 0.3
                ? roundTo((pay.at(-1)!.amountMinor * between(pr, 1, 3)) / 100, 100)
                : 0;
    const emailLocal = `${first}.${last}`.toLowerCase();
    people.push({
      idx: i,
      number: `KS${String(i + 1).padStart(4, '0')}`,
      first,
      last,
      preferred,
      pronouns,
      sex,
      dateOfBirth,
      nationality,
      personalEmail: `${emailLocal}.${i + 1}@personal.example.test`,
      personalPhone: phoneFor(loc, i + 100),
      address: homeAddress(pr, loc, i),
      workEmail: `${emailLocal}@kestrel.example.test`,
      workPhone: s.level === 'member' ? null : phoneFor(loc, i + 500, false),
      entity,
      dept,
      team: t?.key ?? s.exec!.key,
      level: s.level,
      managerIdx: mgr,
      kind: s.kind,
      startDate: start,
      endDate: s.endDate ?? null,
      leaverType: s.leaverType ?? null,
      leaverReason: s.leaverReason ?? null,
      recentStarter: !!s.recentStarter,
      shift: shift ?? (usOfficeHourly ? 'us_office' : null),
      casual,
      flsa: exempt,
      currency,
      jobs,
      pay,
      contract: {
        type: casual ? 'zero_hours' : s.level === 'member' && pr() < 0.04 ? 'fixed_term' : 'permanent',
        noticeDays: s.level === 'exec' ? 90 : s.level === 'lead' ? 60 : 30,
        probationEnd: addMonths(start, 6),
      },
      bonus12mMinor: bonus,
      login,
      emergency,
      tShirt: pr() < 0.7 ? pick(pr, ['S', 'M', 'L', 'XL'] as const) : null,
      parking: loc === 'MAN' || loc === 'NYC' ? pr() < 0.4 : null,
      optOut: shift === 'nights' && s.kind === 'roster' && s.memberIndex < 4,
    });
  }
  if (people.slice(0, rosterSize).length !== size)
    throw new Error(`roster has ${rosterSize} people, expected ${size}`);

  // ---- future-dated changes (first day of next month, and of the month after) ----
  const { year, month } = dateParts(anchor);
  const nextMonth = addMonths(makeDate(year, month, 1), 1);
  const monthAfter = addMonths(nextMonth, 1);
  const futureChanges: FutureChange[] = [];
  const promote = people.find(
    (p) =>
      p.team === 'platform' &&
      p.kind === 'roster' &&
      p.jobs.at(-1)!.title === 'Software engineer' &&
      !p.recentStarter &&
      compareDates(p.startDate, '2024-01-01') < 0,
  );
  if (promote)
    futureChanges.push({
      personIdx: promote.idx,
      effectiveDate: nextMonth,
      kind: 'promotion',
      job: { title: 'Senior software engineer' },
      payAmountMinor: roundTo(SALARY_GBP['Senior software engineer']! * 100, 10000),
      reason: 'Promotion',
    });
  const transfer = people.find(
    (p) =>
      p.team === 'support_lon' &&
      p.kind === 'roster' &&
      !p.recentStarter &&
      p.jobs.at(-1)!.employmentType === 'full_time',
  );
  const ediLead = people.find((p) => p.team === 'support_edi_1' && p.level === 'lead');
  if (transfer && ediLead)
    futureChanges.push({
      personIdx: transfer.idx,
      effectiveDate: weekday(addDays(anchor, 21)),
      kind: 'transfer',
      job: { location: 'EDI' },
      managerIdx: ediLead.idx,
      reason: 'Transfer to the Edinburgh support centre',
    });
  const hours = people.find(
    (p) =>
      p.team === 'wh_a' &&
      p.level === 'member' &&
      p.kind === 'roster' &&
      p.login === null &&
      !p.recentStarter &&
      p.jobs.at(-1)!.title === 'Warehouse operative',
  );
  if (hours)
    futureChanges.push({
      personIdx: hours.idx,
      effectiveDate: monthAfter,
      kind: 'hours',
      job: {
        employmentType: 'part_time',
        fte: 0.8,
        weeklyHours: 30,
        pattern: { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 0, 6: 0, 7: 0 },
      },
      reason: 'Flexible working request: four days a week',
    });

  const logins = {} as Record<LoginRole, number>;
  for (const p of people) if (p.login) logins[p.login] = p.idx;
  return { anchor, size, people, logins, futureChanges, nextMonth };
}

/** Plan helpers shared by the seed steps. */
export const currentJob = (p: PlanPerson, date: string) =>
  [...p.jobs].reverse().find((j) => compareDates(j.from, date) <= 0) ?? p.jobs[0]!;
export const currentPay = (p: PlanPerson, date: string) =>
  [...p.pay].reverse().find((x) => compareDates(x.from, date) <= 0) ?? p.pay[0]!;
export const employedOn = (p: PlanPerson, date: string) =>
  compareDates(p.startDate, date) <= 0 && (!p.endDate || compareDates(p.endDate, date) >= 0);
export const locationOf = (key: LocationKey) => LOCATIONS.find((l) => l.key === key)!;
export const entityOf = (key: EntityKey) => ENTITIES.find((e) => e.key === key)!;
