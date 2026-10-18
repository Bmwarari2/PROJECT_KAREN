import type { TSchema } from 'typebox';
import type { Tx } from '@thapsus/db';
import type { Principal } from '@thapsus/core/permissions';
import type { RuleBook } from '@thapsus/rules';

/**
 * Report result model shared by ready-made reports, the report builder, exports and the web UI.
 * Values are never floating point: integers are JSON numbers, decimals and percentages are fixed-point
 * strings ("12.50"), money is integer minor units (string) + ISO 4217 code, durations are integer minutes.
 */
export type ColumnType = 'text' | 'enum' | 'integer' | 'decimal' | 'percent' | 'money' | 'date' | 'minutes' | 'boolean';

export interface Column {
  key: string;
  /** Message catalogue key for the header. */
  labelKey: string;
  type: ColumnType;
  /** Catalogue prefix for enum values: `${enumKey}.${value}`. */
  enumKey?: string;
  /** Decimal places of decimal / percent values. */
  scale?: number;
  sensitive?: boolean;
}

export interface MoneyCell {
  amountMinor: string;
  currency: string;
}
export type Cell = string | number | boolean | MoneyCell | null;
export type Row = Record<string, Cell>;

export interface ChartHint {
  type: 'bar' | 'line';
  /** Column holding the category / x value. */
  x: string;
  /** Numeric columns plotted as series. */
  y: string[];
}

export interface ReportResult {
  columns: Column[];
  rows: Row[];
  /** Grand totals (one row per currency where money is involved). */
  totals?: Row[];
  chart?: ChartHint;
  /** Catalogue keys of notes shown with the report (method, rounding, restricted rows). */
  notes: string[];
  /** Rows the caller may see but whose grouping or value fields were hidden by field permissions. */
  restricted?: number;
  /** True when the result contains special-category data (the run is audited as a sensitive view). */
  sensitive?: boolean;
}

export interface ReportContext {
  /** Read-only transaction on the tenant's reporting reader (RLS applies). */
  tx: Tx;
  principal: Principal;
  book: RuleBook;
  tenant: { homeRegion: string; defaultCurrency: string; timeZone: string; features: Record<string, unknown> };
  /** Translator for the run's locale (labels such as "Unassigned" inside result rows). */
  t: (key: string, vars?: Record<string, string | number>) => string;
  progress?: (done: number, total?: number) => Promise<void>;
}

export type Jurisdiction = '*' | 'GB' | 'US' | 'EU';

export interface ReportDefinition<P = Record<string, unknown>> {
  id: string;
  category: 'people' | 'absence' | 'time' | 'pay' | 'compliance';
  titleKey: string;
  descriptionKey: string;
  /** Row-scope action (scope predicate) the caller must hold for some scope. */
  permission: string;
  jurisdictions: Jurisdiction[];
  sensitivity: 'standard' | 'personal' | 'special';
  params: TSchema;
  /** 'pending_integration': registered, wired to the phase 5 compliance calculators when merged. */
  status: 'available' | 'pending_integration';
  run(ctx: ReportContext, params: P): Promise<ReportResult>;
}

/** Group dimensions shared by the ready-made reports. */
export const GROUP_BY = ['entity', 'department', 'location', 'country', 'none'] as const;
export type GroupBy = (typeof GROUP_BY)[number];
