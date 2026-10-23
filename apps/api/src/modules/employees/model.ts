/**
 * Employee field model: API field names, their columns, their effective-dated section and the
 * permission key used for field-level access (`employee.<key>`).
 */
export type Section = 'core' | 'personal' | 'job' | 'pay' | 'contract';

export interface FieldDef {
  section: Section;
  column: string;
  perm: string; // field key under resource "employee"
  type: 'text' | 'date' | 'uuid' | 'number' | 'json' | 'enum';
  enum?: readonly string[];
}

export const FIELDS: Record<string, FieldDef> = {
  employeeNumber: { section: 'core', column: 'employee_number', perm: 'employeeNumber', type: 'text' },
  startDate: { section: 'core', column: 'start_date', perm: 'startDate', type: 'date' },
  endDate: { section: 'core', column: 'end_date', perm: 'endDate', type: 'date' },
  workEmail: { section: 'core', column: 'work_email', perm: 'workEmail', type: 'text' },
  workPhone: { section: 'core', column: 'work_phone', perm: 'workPhone', type: 'text' },

  legalFirstName: { section: 'personal', column: 'legal_first_name', perm: 'legalFirstName', type: 'text' },
  legalLastName: { section: 'personal', column: 'legal_last_name', perm: 'legalLastName', type: 'text' },
  preferredName: { section: 'personal', column: 'preferred_name', perm: 'preferredName', type: 'text' },
  pronouns: { section: 'personal', column: 'pronouns', perm: 'pronouns', type: 'text' },
  dateOfBirth: { section: 'personal', column: 'date_of_birth', perm: 'dateOfBirth', type: 'date' },
  personalEmail: { section: 'personal', column: 'personal_email', perm: 'personalEmail', type: 'text' },
  personalPhone: { section: 'personal', column: 'personal_phone', perm: 'personalPhone', type: 'text' },
  address: { section: 'personal', column: 'address', perm: 'address', type: 'json' },
  nationality: { section: 'personal', column: 'nationality', perm: 'nationality', type: 'text' },

  jobTitle: { section: 'job', column: 'job_title', perm: 'jobTitle', type: 'text' },
  positionId: { section: 'job', column: 'position_id', perm: 'position', type: 'uuid' },
  departmentId: { section: 'job', column: 'department_id', perm: 'department', type: 'uuid' },
  locationId: { section: 'job', column: 'location_id', perm: 'location', type: 'uuid' },
  entityId: { section: 'job', column: 'entity_id', perm: 'entity', type: 'uuid' },
  costCentreId: { section: 'job', column: 'cost_centre_id', perm: 'costCentre', type: 'uuid' },
  gradeId: { section: 'job', column: 'grade_id', perm: 'pay.grade', type: 'uuid' },
  employmentType: {
    section: 'job',
    column: 'employment_type',
    perm: 'employmentType',
    type: 'enum',
    enum: ['full_time', 'part_time', 'casual', 'contractor', 'intern'],
  },
  fte: { section: 'job', column: 'fte', perm: 'fte', type: 'number' },
  weeklyHours: { section: 'job', column: 'weekly_hours', perm: 'weeklyHours', type: 'number' },
  workPattern: { section: 'job', column: 'work_pattern', perm: 'workPattern', type: 'json' },
  flsaStatus: {
    section: 'job',
    column: 'flsa_status',
    perm: 'flsaStatus',
    type: 'enum',
    enum: ['exempt', 'non_exempt'],
  },

  payAmountMinor: { section: 'pay', column: 'amount_minor', perm: 'pay.amount', type: 'number' },
  payCurrency: { section: 'pay', column: 'currency', perm: 'pay.amount', type: 'text' },
  payFrequency: {
    section: 'pay',
    column: 'frequency',
    perm: 'pay.amount',
    type: 'enum',
    enum: ['annual', 'monthly', 'weekly', 'hourly', 'daily'],
  },

  contractType: {
    section: 'contract',
    column: 'contract_type',
    perm: 'contract.type',
    type: 'enum',
    enum: ['permanent', 'fixed_term', 'zero_hours', 'temporary', 'contractor', 'apprenticeship'],
  },
  noticePeriodDays: {
    section: 'contract',
    column: 'notice_period_days',
    perm: 'contract.noticePeriod',
    type: 'number',
  },
  probationEndDate: {
    section: 'contract',
    column: 'probation_end_date',
    perm: 'contract.probation',
    type: 'date',
  },
};

export const SECTION_TABLE: Record<Exclude<Section, 'core'>, string> = {
  personal: 'app.employee_personal',
  job: 'app.employee_jobs',
  pay: 'app.employee_pay',
  contract: 'app.employee_contracts',
};

/** Fields required when a section record is first created. */
export const REQUIRED: Record<Exclude<Section, 'core'>, string[]> = {
  personal: ['legalFirstName', 'legalLastName'],
  job: ['jobTitle', 'entityId'],
  pay: ['payAmountMinor', 'payCurrency', 'payFrequency'],
  contract: ['contractType'],
};

/** Read-only derived fields and the permission key that governs them. */
export const DERIVED_PERMS: Record<string, string> = {
  id: 'id',
  status: 'status',
  displayName: 'displayName',
  department: 'department',
  location: 'location',
  entity: 'entity',
  country: 'location',
  manager: 'manager',
  managerId: 'manager',
  photoUrl: 'photoUrl',
  custom: 'custom',
  position: 'position',
  grade: 'pay.grade',
  costCentre: 'costCentre',
};

export function permKeyFor(field: string): string {
  return FIELDS[field]?.perm ?? DERIVED_PERMS[field] ?? field;
}

export function sectionsOf(values: Record<string, unknown>) {
  const out: Partial<Record<Section, Record<string, unknown>>> = {};
  for (const [k, v] of Object.entries(values)) {
    const def = FIELDS[k];
    if (!def) continue;
    (out[def.section] ??= {})[k] = v;
  }
  return out;
}
