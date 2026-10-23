import { money, toDecimalString } from '@thapsus/core';
import { dateParts } from '@thapsus/core/time';
import type { InputEmployee, PayrollInputs, SectionKey } from './inputs';
import { SECTIONS } from './inputs';

/**
 * Per-tenant field mapping: which Thapsus fields go to which target columns, per section, with simple
 * transforms (date formats, number precision, money units, code maps, booleans, letter case and fixed
 * values). The catalogue below is the complete list of fields a connector can send; nothing outside it
 * ever leaves the platform through a payroll connector.
 */
export type FieldType = 'text' | 'date' | 'datetime' | 'duration' | 'number' | 'money' | 'boolean';

export interface FieldDef {
  type: FieldType;
  /** For money fields: the row property holding the ISO currency. */
  currencyFrom?: string;
}

const COMMON: Record<string, FieldDef> = {
  employeeNumber: { type: 'text' },
  firstName: { type: 'text' },
  lastName: { type: 'text' },
  employeeName: { type: 'text' },
  periodName: { type: 'text' },
  periodStart: { type: 'date' },
  periodEnd: { type: 'date' },
  payDate: { type: 'date' },
};

export const FIELD_CATALOGUE: Record<SectionKey, Record<string, FieldDef>> = {
  hours: {
    ...COMMON,
    weekStart: { type: 'date' },
    weekEnd: { type: 'date' },
    workedHours: { type: 'duration' },
    regularHours: { type: 'duration' },
    overtimeHours: { type: 'duration' },
    doubleTimeHours: { type: 'duration' },
    approvedAt: { type: 'datetime' },
  },
  absences: {
    ...COMMON,
    leaveType: { type: 'text' },
    leaveCategory: { type: 'text' },
    paid: { type: 'boolean' },
    startDate: { type: 'date' },
    endDate: { type: 'date' },
    days: { type: 'number' },
    hours: { type: 'number' },
  },
  sickPay: {
    ...COMMON,
    scheme: { type: 'text' },
    sicknessDays: { type: 'number' },
    qualifyingDaysPaid: { type: 'number' },
    waitingDays: { type: 'number' },
    amount: { type: 'money', currencyFrom: 'currency' },
    weeklyRate: { type: 'money', currencyFrom: 'currency' },
    currency: { type: 'text' },
  },
  payChanges: {
    ...COMMON,
    effectiveDate: { type: 'date' },
    amount: { type: 'money', currencyFrom: 'currency' },
    currency: { type: 'text' },
    frequency: { type: 'text' },
    previousAmount: { type: 'money', currencyFrom: 'previousCurrency' },
    previousFrequency: { type: 'text' },
  },
  starters: {
    ...COMMON,
    startDate: { type: 'date' },
    dateOfBirth: { type: 'date' },
    workEmail: { type: 'text' },
    jobTitle: { type: 'text' },
    employmentType: { type: 'text' },
    contractType: { type: 'text' },
    weeklyHours: { type: 'number' },
    payAmount: { type: 'money', currencyFrom: 'currency' },
    currency: { type: 'text' },
    payFrequency: { type: 'text' },
  },
  leavers: { ...COMMON, lastWorkingDay: { type: 'date' } },
};

export const DATE_FORMATS = [
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'dd.MM.yyyy',
  'yyyyMMdd',
  'dd-MM-yyyy',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export type Transform =
  | { type: 'date'; format: DateFormat }
  | { type: 'number'; decimals: number }
  | { type: 'hours'; decimals: number }
  | { type: 'minutes' }
  | { type: 'money'; unit: 'major' | 'minor' }
  | { type: 'codeMap'; map: Record<string, string>; default?: string }
  | { type: 'boolean'; true: string; false: string }
  | { type: 'case'; case: 'upper' | 'lower' };

export interface ColumnMapping {
  header: string;
  field?: string;
  /** A fixed value (e.g. a pay element code) instead of a field. */
  value?: string;
  transform?: Transform;
}
export interface SectionMapping {
  enabled: boolean;
  columns: ColumnMapping[];
}
export interface FieldMapping {
  dateFormat: DateFormat;
  decimalSeparator: '.' | ',';
  delimiter: ',' | ';' | '\t' | '|';
  includeHeader: boolean;
  sections: Partial<Record<SectionKey, SectionMapping>>;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Every catalogue field, snake_case headers, all sections on. */
export function defaultMapping(): FieldMapping {
  return {
    dateFormat: 'yyyy-MM-dd',
    decimalSeparator: '.',
    delimiter: ',',
    includeHeader: true,
    sections: Object.fromEntries(
      SECTIONS.map((s) => [
        s,
        {
          enabled: true,
          columns: Object.keys(FIELD_CATALOGUE[s])
            .filter(
              (f) =>
                !['periodName', 'periodStart', 'periodEnd', 'payDate', 'firstName', 'lastName'].includes(f),
            )
            .map((f) => ({ header: snake(f), field: f })),
        },
      ]),
    ),
  };
}

/** Returns problems with a mapping (empty when valid). */
export function validateMapping(m: FieldMapping): string[] {
  const problems: string[] = [];
  if (!DATE_FORMATS.includes(m.dateFormat)) problems.push(`dateFormat: unsupported ${m.dateFormat}`);
  if (m.delimiter === m.decimalSeparator) problems.push('delimiter and decimalSeparator must differ');
  let enabled = 0;
  for (const [section, sm] of Object.entries(m.sections)) {
    if (!(SECTIONS as readonly string[]).includes(section)) {
      problems.push(`sections.${section}: unknown section`);
      continue;
    }
    if (!sm?.enabled) continue;
    enabled++;
    if (!sm.columns.length) problems.push(`sections.${section}: no columns`);
    const headers = new Set<string>();
    sm.columns.forEach((c, i) => {
      const at = `sections.${section}.columns[${i}]`;
      if (!c.header.trim()) problems.push(`${at}: empty header`);
      if (headers.has(c.header)) problems.push(`${at}: duplicate header ${c.header}`);
      headers.add(c.header);
      if ((c.field === undefined) === (c.value === undefined)) {
        problems.push(`${at}: set exactly one of field or value`);
        return;
      }
      if (c.field === undefined) return;
      const def = FIELD_CATALOGUE[section as SectionKey][c.field];
      if (!def) {
        problems.push(`${at}: unknown field ${c.field} for ${section}`);
        return;
      }
      const t = c.transform;
      if (!t) return;
      const ok =
        (t.type === 'date' && (def.type === 'date' || def.type === 'datetime')) ||
        (t.type === 'number' && def.type === 'number') ||
        ((t.type === 'hours' || t.type === 'minutes') && def.type === 'duration') ||
        (t.type === 'money' && def.type === 'money') ||
        (t.type === 'boolean' && def.type === 'boolean') ||
        ((t.type === 'codeMap' || t.type === 'case') && def.type === 'text');
      if (!ok) problems.push(`${at}: transform ${t.type} does not apply to ${def.type} field ${c.field}`);
      if (
        (t.type === 'number' || t.type === 'hours') &&
        !(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 4)
      )
        problems.push(`${at}: decimals must be 0-4`);
      if (t.type === 'date' && !DATE_FORMATS.includes(t.format))
        problems.push(`${at}: unsupported date format`);
    });
  }
  if (!enabled) problems.push('enable at least one section');
  return problems;
}

// ---- values ----------------------------------------------------------------------------------------------------
export type CellValue = { kind: 'text' | 'number'; text: string; number?: number };

export function formatDate(date: string, format: DateFormat): string {
  const { year, month, day } = dateParts(date);
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  switch (format) {
    case 'dd/MM/yyyy':
      return `${d}/${m}/${y}`;
    case 'MM/dd/yyyy':
      return `${m}/${d}/${y}`;
    case 'dd.MM.yyyy':
      return `${d}.${m}.${y}`;
    case 'dd-MM-yyyy':
      return `${d}-${m}-${y}`;
    case 'yyyyMMdd':
      return `${y}${m}${d}`;
    default:
      return `${y}-${m}-${d}`;
  }
}

/** Decimal string of `units / divisor` rounded half away from zero to `decimals`, using integers only. */
export function ratioToDecimal(units: number, divisor: number, decimals: number): string {
  const scale = 10 ** decimals;
  const neg = units < 0;
  const n = BigInt(Math.abs(Math.round(units))) * BigInt(scale);
  const q = BigInt(divisor);
  let r = n / q;
  if ((n % q) * 2n >= q) r += 1n;
  const s = r.toString().padStart(decimals + 1, '0');
  const out = decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
  return neg && r !== 0n ? `-${out}` : out;
}

function decimalOf(value: number, decimals: number): string {
  // values here come from numeric(8,4) columns (at most 4 decimal places), so scaling by 10^4 is exact
  return ratioToDecimal(Math.round(value * 10_000), 10_000, decimals);
}

function sep(s: string, m: FieldMapping) {
  return m.decimalSeparator === ',' ? s.replace('.', ',') : s;
}

/** Raw value of a field for a row (before transforms). */
function rawValue(
  section: SectionKey,
  field: string,
  row: Record<string, unknown>,
  emp: InputEmployee | undefined,
  inputs: PayrollInputs,
): unknown {
  switch (field) {
    case 'firstName':
      return emp?.firstName ?? '';
    case 'lastName':
      return emp?.lastName ?? '';
    case 'employeeName':
      return emp?.displayName ?? '';
    case 'periodName':
      return inputs.period.name;
    case 'periodStart':
      return inputs.period.startDate;
    case 'periodEnd':
      return inputs.period.endDate;
    case 'payDate':
      return inputs.period.payDate;
  }
  if (section === 'hours') {
    const map: Record<string, string> = {
      workedHours: 'workedMinutes',
      regularHours: 'regularMinutes',
      overtimeHours: 'overtimeMinutes',
      doubleTimeHours: 'doubleMinutes',
    };
    if (map[field]) return row[map[field]!];
  }
  if (section === 'sickPay' && field === 'amount') return row.amountMinor;
  if (section === 'sickPay' && field === 'weeklyRate') return row.weeklyRateMinor;
  if (section === 'payChanges' && field === 'amount') return row.amountMinor;
  if (section === 'payChanges' && field === 'previousAmount') return row.previousAmountMinor;
  if (section === 'starters' && field === 'payAmount') return row.payAmountMinor;
  if (section === 'leavers' && field === 'lastWorkingDay') return row.endDate;
  return row[field];
}

export function cellFor(
  section: SectionKey,
  col: ColumnMapping,
  row: Record<string, unknown>,
  emp: InputEmployee | undefined,
  inputs: PayrollInputs,
  m: FieldMapping,
): CellValue {
  if (col.value !== undefined) return { kind: 'text', text: col.value };
  const def = FIELD_CATALOGUE[section][col.field!]!;
  const v = rawValue(section, col.field!, row, emp, inputs);
  const t = col.transform;
  if (v === null || v === undefined || v === '') {
    if (t?.type === 'codeMap' && t.default !== undefined) return { kind: 'text', text: t.default };
    return { kind: 'text', text: '' };
  }
  switch (def.type) {
    case 'date':
      return {
        kind: 'text',
        text: formatDate(String(v).slice(0, 10), t?.type === 'date' ? t.format : m.dateFormat),
      };
    case 'datetime':
      return {
        kind: 'text',
        text: t?.type === 'date' ? formatDate(String(v).slice(0, 10), t.format) : String(v),
      };
    case 'duration': {
      const minutes = Number(v);
      if (t?.type === 'minutes') return { kind: 'number', text: String(minutes), number: minutes };
      const s = ratioToDecimal(minutes, 60, t?.type === 'hours' ? t.decimals : 2);
      return { kind: 'number', text: sep(s, m), number: Number(s) };
    }
    case 'number': {
      const s = t?.type === 'number' ? decimalOf(Number(v), t.decimals) : String(Number(v));
      return { kind: 'number', text: sep(s, m), number: Number(s) };
    }
    case 'money': {
      const minor = Number(v);
      if (t?.type === 'money' && t.unit === 'minor')
        return { kind: 'number', text: String(minor), number: minor };
      const currency = String(row[def.currencyFrom ?? 'currency'] ?? 'GBP');
      const s = toDecimalString(money(BigInt(minor), currency));
      return { kind: 'number', text: sep(s, m), number: Number(s) };
    }
    case 'boolean':
      return { kind: 'text', text: t?.type === 'boolean' ? (v ? t.true : t.false) : v ? 'true' : 'false' };
    default: {
      let s = String(v);
      if (t?.type === 'codeMap') s = t.map[s] ?? t.default ?? s;
      if (t?.type === 'case') s = t.case === 'upper' ? s.toUpperCase() : s.toLowerCase();
      return { kind: 'text', text: s };
    }
  }
}

export interface SectionTable {
  section: SectionKey;
  headers: string[];
  rows: CellValue[][];
}

/** Applies the mapping to every enabled section, in catalogue order. */
export function mapInputs(inputs: PayrollInputs, m: FieldMapping): SectionTable[] {
  const emps = new Map(inputs.employees.map((e) => [e.employeeId, e]));
  const out: SectionTable[] = [];
  for (const section of SECTIONS) {
    const sm = m.sections[section];
    if (!sm?.enabled) continue;
    const rows = (inputs[section] as unknown as Array<Record<string, unknown>>).map((r) =>
      sm.columns.map((c) => cellFor(section, c, r, emps.get(String(r.employeeId)), inputs, m)),
    );
    out.push({ section, headers: sm.columns.map((c) => c.header), rows });
  }
  return out;
}
