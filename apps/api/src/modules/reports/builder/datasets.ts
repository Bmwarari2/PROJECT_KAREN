import type { VaultCategory } from '../../vault/service';

/**
 * Report-builder dataset catalogue. Every field declares its SQL, type, i18n label key, sensitivity and the
 * employee field permission that governs it (`employee.<perm>`, as in the employee field model); `perm: null`
 * means the dataset's row permission alone governs it (e.g. a timesheet's minutes). Vault-backed fields are
 * never read on the reporting reader (it has no vault grants): they are decrypted on the writer only for
 * callers holding `vault.read:<category>` for the row, and every value read is audited.
 *
 * SQL tokens {asOf}, {from} and {to} are replaced by bound parameters.
 */
export type FieldType = 'text' | 'enum' | 'integer' | 'decimal' | 'money' | 'date' | 'minutes' | 'boolean';

export interface DatasetField {
  key: string;
  type: FieldType;
  sql: string;
  perm: string | null;
  sensitivity: 'standard' | 'personal' | 'special';
  joins?: string[];
  enumValues?: readonly string[];
  /** Currency column for money fields (masked together with the amount). */
  currencySql?: string;
  scale?: number;
  vault?: { category: VaultCategory; field: string };
}

export interface Dataset {
  key: 'employees' | 'leave' | 'absence' | 'timesheets';
  /** Row scope action (scope predicate on alias e). */
  permission: string;
  sensitivity: 'standard' | 'personal' | 'special';
  /** 'asOf' datasets read effective-dated records on a date; 'period' datasets select records overlapping [from, to]. */
  time: 'asOf' | 'period';
  from: string;
  joins: Record<string, { sql: string; requires?: string[] }>;
  where: string[];
  fields: DatasetField[];
}

const STATUS = ['active', 'pre_start', 'leaver'] as const;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'casual', 'contractor', 'intern'] as const;
const CONTRACT_TYPES = ['permanent', 'fixed_term', 'zero_hours', 'temporary', 'contractor', 'apprenticeship'] as const;
const PAY_FREQUENCIES = ['annual', 'monthly', 'weekly', 'hourly', 'daily'] as const;
const LEAVER_TYPES = ['voluntary', 'involuntary', 'other'] as const;
const LEAVE_CATEGORIES = ['annual', 'sickness', 'unpaid', 'family', 'toil', 'fmla', 'other'] as const;
const LEAVE_STATUS = ['pending', 'approved', 'rejected', 'cancelled'] as const;
const TIMESHEET_STATUS = ['open', 'submitted', 'approved', 'rejected'] as const;
const RTW_STATUS = ['not_required', 'due', 'completed'] as const;

const asOfLateral = (alias: string, table: string) =>
  `LEFT JOIN LATERAL (SELECT * FROM ${table} x WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id AND x.valid_from <= {asOf} AND (x.valid_to IS NULL OR x.valid_to > {asOf}) LIMIT 1) ${alias} ON true`;

/** Current (denormalised) organisation joins on the employee row, used by the period datasets. */
const currentOrgJoins = {
  cd: { sql: 'LEFT JOIN app.departments cd ON cd.tenant_id = e.tenant_id AND cd.id = e.department_id' },
  cl: { sql: 'LEFT JOIN app.locations cl ON cl.tenant_id = e.tenant_id AND cl.id = e.location_id' },
  cle: { sql: 'LEFT JOIN app.legal_entities cle ON cle.tenant_id = e.tenant_id AND cle.id = e.entity_id' },
};

/** Who the row is about (current values), shared by the period datasets. */
const personFields = (sensitivity: DatasetField['sensitivity'] = 'standard'): DatasetField[] => [
  { key: 'employeeNumber', type: 'text', sql: 'e.employee_number', perm: 'employeeNumber', sensitivity },
  { key: 'displayName', type: 'text', sql: 'e.display_name', perm: 'displayName', sensitivity },
  { key: 'department', type: 'text', sql: 'cd.name', perm: 'department', sensitivity, joins: ['cd'] },
  { key: 'location', type: 'text', sql: 'cl.name', perm: 'location', sensitivity, joins: ['cl'] },
  { key: 'entity', type: 'text', sql: 'cle.name', perm: 'entity', sensitivity, joins: ['cle'] },
  { key: 'country', type: 'text', sql: 'e.country', perm: 'location', sensitivity },
];

export const DATASETS: Dataset[] = [
  {
    key: 'employees',
    permission: 'employees.read',
    sensitivity: 'personal',
    time: 'asOf',
    from: 'app.employees e',
    joins: {
      j: { sql: asOfLateral('j', 'app.employee_jobs') },
      p: { sql: asOfLateral('p', 'app.employee_personal') },
      pay: { sql: asOfLateral('pay', 'app.employee_pay') },
      c: { sql: asOfLateral('c', 'app.employee_contracts') },
      d: { sql: 'LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = j.department_id', requires: ['j'] },
      l: { sql: 'LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = j.location_id', requires: ['j'] },
      le: { sql: 'LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = j.entity_id', requires: ['j'] },
      m: { sql: 'LEFT JOIN app.employees m ON m.tenant_id = e.tenant_id AND m.id = e.manager_id' },
    },
    where: [],
    fields: [
      { key: 'employeeNumber', type: 'text', sql: 'e.employee_number', perm: 'employeeNumber', sensitivity: 'standard' },
      { key: 'displayName', type: 'text', sql: 'e.display_name', perm: 'displayName', sensitivity: 'standard' },
      { key: 'status', type: 'enum', enumValues: STATUS, sql: `CASE WHEN e.end_date IS NOT NULL AND e.end_date < {asOf} THEN 'leaver' WHEN e.start_date > {asOf} THEN 'pre_start' ELSE 'active' END`, perm: 'status', sensitivity: 'standard' },
      { key: 'startDate', type: 'date', sql: 'e.start_date', perm: 'startDate', sensitivity: 'standard' },
      { key: 'endDate', type: 'date', sql: 'e.end_date', perm: 'endDate', sensitivity: 'standard' },
      { key: 'leaverType', type: 'enum', enumValues: LEAVER_TYPES, sql: 'e.leaver_type', perm: 'endDate', sensitivity: 'standard' },
      { key: 'serviceMonths', type: 'integer', sql: `CASE WHEN e.start_date <= {asOf} THEN (extract(year FROM age({asOf}, e.start_date)) * 12 + extract(month FROM age({asOf}, e.start_date)))::int END`, perm: 'startDate', sensitivity: 'standard' },
      { key: 'workEmail', type: 'text', sql: 'e.work_email::text', perm: 'workEmail', sensitivity: 'standard' },
      { key: 'jobTitle', type: 'text', sql: 'j.job_title', perm: 'jobTitle', sensitivity: 'standard', joins: ['j'] },
      { key: 'department', type: 'text', sql: 'd.name', perm: 'department', sensitivity: 'standard', joins: ['d'] },
      { key: 'location', type: 'text', sql: 'l.name', perm: 'location', sensitivity: 'standard', joins: ['l'] },
      { key: 'entity', type: 'text', sql: 'le.name', perm: 'entity', sensitivity: 'standard', joins: ['le'] },
      { key: 'country', type: 'text', sql: 'coalesce(l.country, le.country)', perm: 'location', sensitivity: 'standard', joins: ['l', 'le'] },
      { key: 'manager', type: 'text', sql: 'm.display_name', perm: 'manager', sensitivity: 'standard', joins: ['m'] },
      { key: 'employmentType', type: 'enum', enumValues: EMPLOYMENT_TYPES, sql: 'j.employment_type', perm: 'employmentType', sensitivity: 'standard', joins: ['j'] },
      { key: 'fte', type: 'decimal', scale: 4, sql: 'j.fte', perm: 'fte', sensitivity: 'standard', joins: ['j'] },
      { key: 'weeklyHours', type: 'decimal', scale: 2, sql: 'j.weekly_hours', perm: 'weeklyHours', sensitivity: 'standard', joins: ['j'] },
      { key: 'contractType', type: 'enum', enumValues: CONTRACT_TYPES, sql: 'c.contract_type', perm: 'contract.type', sensitivity: 'standard', joins: ['c'] },
      { key: 'probationEndDate', type: 'date', sql: 'c.probation_end_date', perm: 'contract.probation', sensitivity: 'standard', joins: ['c'] },
      { key: 'payAmount', type: 'money', sql: 'pay.amount_minor', currencySql: 'pay.currency', perm: 'pay.amount', sensitivity: 'personal', joins: ['pay'] },
      { key: 'payFrequency', type: 'enum', enumValues: PAY_FREQUENCIES, sql: 'pay.frequency', perm: 'pay.amount', sensitivity: 'personal', joins: ['pay'] },
      { key: 'dateOfBirth', type: 'date', sql: 'p.date_of_birth', perm: 'dateOfBirth', sensitivity: 'personal', joins: ['p'] },
      { key: 'nationality', type: 'text', sql: 'p.nationality', perm: 'nationality', sensitivity: 'personal', joins: ['p'] },
      // Vault-backed (special category): decrypted on the writer for permitted rows only; each value read is audited.
      { key: 'disabilityStatus', type: 'text', sql: 'NULL', perm: null, sensitivity: 'special', vault: { category: 'disability', field: 'status' } },
      { key: 'eeoSex', type: 'text', sql: 'NULL', perm: null, sensitivity: 'special', vault: { category: 'eeo', field: 'sex' } },
      { key: 'eeoRaceEthnicity', type: 'text', sql: 'NULL', perm: null, sensitivity: 'special', vault: { category: 'eeo', field: 'race_ethnicity' } },
    ],
  },
  {
    key: 'leave',
    permission: 'leave.read',
    sensitivity: 'personal',
    time: 'period',
    from: 'app.leave_requests r JOIN app.employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id JOIN app.leave_types t ON t.tenant_id = r.tenant_id AND t.id = r.leave_type_id',
    joins: currentOrgJoins,
    // Sickness is health data: it is reported through the absence dataset (absence permission) only.
    where: [`t.category <> 'sickness'`, 'r.start_date <= {to}', 'r.end_date >= {from}'],
    fields: [
      ...personFields(),
      { key: 'leaveType', type: 'text', sql: 't.key', perm: null, sensitivity: 'standard' },
      { key: 'leaveCategory', type: 'enum', enumValues: LEAVE_CATEGORIES, sql: 't.category', perm: null, sensitivity: 'standard' },
      { key: 'startDate', type: 'date', sql: 'r.start_date', perm: null, sensitivity: 'standard' },
      { key: 'endDate', type: 'date', sql: 'r.end_date', perm: null, sensitivity: 'standard' },
      { key: 'days', type: 'decimal', scale: 2, sql: 'r.amount_days', perm: null, sensitivity: 'standard' },
      { key: 'hours', type: 'decimal', scale: 2, sql: 'r.amount_hours', perm: null, sensitivity: 'standard' },
      { key: 'requestStatus', type: 'enum', enumValues: LEAVE_STATUS, sql: 'r.status', perm: null, sensitivity: 'standard' },
    ],
  },
  {
    key: 'absence',
    permission: 'absence.read',
    sensitivity: 'special',
    time: 'period',
    from: 'app.sickness_records s JOIN app.employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id LEFT JOIN app.leave_requests lr ON lr.tenant_id = s.tenant_id AND lr.id = s.leave_request_id',
    joins: currentOrgJoins,
    where: ['s.start_date <= {to}', 'coalesce(s.end_date, {to}) >= {from}'],
    fields: [
      ...personFields('special'),
      { key: 'startDate', type: 'date', sql: 's.start_date', perm: null, sensitivity: 'special' },
      { key: 'endDate', type: 'date', sql: 's.end_date', perm: null, sensitivity: 'special' },
      { key: 'days', type: 'decimal', scale: 2, sql: 'lr.amount_days', perm: null, sensitivity: 'special' },
      { key: 'hours', type: 'decimal', scale: 2, sql: 'lr.amount_hours', perm: null, sensitivity: 'special' },
      { key: 'fitNoteRequired', type: 'boolean', sql: 's.fit_note_required', perm: null, sensitivity: 'special' },
      { key: 'returnToWork', type: 'enum', enumValues: RTW_STATUS, sql: 's.rtw_status', perm: null, sensitivity: 'special' },
    ],
  },
  {
    key: 'timesheets',
    permission: 'time.read',
    sensitivity: 'standard',
    time: 'period',
    from: 'app.timesheets ts JOIN app.employees e ON e.tenant_id = ts.tenant_id AND e.id = ts.employee_id',
    joins: currentOrgJoins,
    where: ['ts.week_start >= {from}', 'ts.week_start <= {to}'],
    fields: [
      ...personFields(),
      { key: 'weekStart', type: 'date', sql: 'ts.week_start', perm: null, sensitivity: 'standard' },
      { key: 'timesheetStatus', type: 'enum', enumValues: TIMESHEET_STATUS, sql: 'ts.status', perm: null, sensitivity: 'standard' },
      { key: 'workedMinutes', type: 'minutes', sql: 'ts.worked_minutes', perm: null, sensitivity: 'standard' },
      { key: 'regularMinutes', type: 'minutes', sql: 'ts.regular_minutes', perm: null, sensitivity: 'standard' },
      { key: 'overtimeMinutes', type: 'minutes', sql: 'ts.overtime_minutes', perm: null, sensitivity: 'standard' },
      { key: 'doubleMinutes', type: 'minutes', sql: 'ts.double_minutes', perm: null, sensitivity: 'standard' },
      { key: 'scheduledMinutes', type: 'minutes', sql: 'ts.scheduled_minutes', perm: null, sensitivity: 'standard' },
    ],
  },
];

export function dataset(key: string): Dataset | undefined {
  return DATASETS.find((d) => d.key === key);
}

export const GROUPABLE: FieldType[] = ['text', 'enum', 'date', 'boolean'];
export const NUMERIC: FieldType[] = ['integer', 'decimal', 'money', 'minutes'];
