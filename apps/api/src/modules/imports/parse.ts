import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { isCivilDate } from '@thapsus/core/time';
import { parseDecimal } from '@thapsus/core/money';
import { FIELDS } from '../employees/model';

export interface Table {
  headers: string[];
  rows: string[][];
}

export async function readTable(buf: Buffer, fileName: string): Promise<Table> {
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    const all: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (v && typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text);
        if (v && typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '');
        return v === null || v === undefined ? '' : String(v);
      });
      all.push(vals);
    });
    return { headers: (all[0] ?? []).map((h) => h.trim()), rows: all.slice(1) };
  }
  const records = parseCsv(buf, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  return { headers: (records[0] ?? []).map((h) => h.trim()), rows: records.slice(1) };
}

/** Importable columns: employee fields plus identity and manager columns. */
export const IMPORT_TARGETS = ['employeeNumber', 'startDate', 'effectiveDate', 'endDate', 'workEmail', 'managerEmployeeNumber', ...Object.keys(FIELDS).filter((k) => FIELDS[k]!.section !== 'core'), 'entityName', 'departmentName', 'locationName'] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Suggests a mapping from file headers to import targets by normalised name. */
export function suggestMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const aliases: Record<string, string> = { firstname: 'legalFirstName', lastname: 'legalLastName', surname: 'legalLastName', title: 'jobTitle', salary: 'payAmountMinor', currency: 'payCurrency', department: 'departmentName', location: 'locationName', entity: 'entityName', manager: 'managerEmployeeNumber', email: 'workEmail', employeeid: 'employeeNumber', number: 'employeeNumber' };
  for (const h of headers) {
    const n = norm(h);
    const direct = IMPORT_TARGETS.find((t) => norm(t) === n);
    if (direct) out[h] = direct;
    else if (aliases[n]) out[h] = aliases[n]!;
  }
  return out;
}

export interface RowError {
  row: number;
  column: string;
  message: string;
}

/** Validates one mapped row; returns typed values and row-level errors (row numbers are 1-based, header = row 1). */
export function validateRow(raw: Record<string, string>, rowNumber: number, refs: { entities: Map<string, string>; departments: Map<string, string>; locations: Map<string, string> }) {
  const errors: RowError[] = [];
  const v: Record<string, unknown> = {};
  const err = (column: string, message: string) => errors.push({ row: rowNumber, column, message });
  let amount: string | undefined;
  for (const [k, val] of Object.entries(raw)) {
    const value = val.trim();
    if (value === '') continue;
    if (['startDate', 'effectiveDate', 'endDate'].includes(k) || FIELDS[k]?.type === 'date') {
      if (!isCivilDate(value)) err(k, 'expected a date (YYYY-MM-DD)');
      else v[k] = value;
      continue;
    }
    if (k === 'payAmountMinor') {
      amount = value; // converted below, once the currency (and so its minor-unit exponent) is known
      continue;
    }
    if (FIELDS[k]?.type === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(value)) err(k, 'expected a number');
      else v[k] = Number(value);
      continue;
    }
    if (FIELDS[k]?.enum && !FIELDS[k]!.enum!.includes(value)) {
      err(k, `expected one of ${FIELDS[k]!.enum!.join(', ')}`);
      continue;
    }
    if (k === 'entityName') {
      const id = refs.entities.get(value.toLowerCase());
      if (!id) err(k, 'unknown legal entity');
      else v.entityId = id;
      continue;
    }
    if (k === 'departmentName') {
      const id = refs.departments.get(value.toLowerCase());
      if (!id) err(k, 'unknown department');
      else v.departmentId = id;
      continue;
    }
    if (k === 'locationName') {
      const id = refs.locations.get(value.toLowerCase());
      if (!id) err(k, 'unknown location');
      else v.locationId = id;
      continue;
    }
    if (k === 'workEmail' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      err(k, 'invalid email');
      continue;
    }
    v[k] = value;
  }
  if (amount !== undefined) {
    // decimal → integer minor units without floating point (e.g. 48000.50 GBP → 4800050, 5000 JPY → 5000)
    const currency = String(v.payCurrency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) err('payCurrency', 'required with an amount');
    else if (!/^\d+(\.\d+)?$/.test(amount)) err('payAmountMinor', 'expected an amount like 45000 or 45000.50');
    else {
      try {
        v.payAmountMinor = Number(parseDecimal(amount, currency).amountMinor);
        v.payCurrency = currency;
      } catch {
        err('payAmountMinor', `too many decimal places for ${currency}`);
      }
    }
  }
  if (!v.employeeNumber) err('employeeNumber', 'required');
  return { values: v, errors };
}
