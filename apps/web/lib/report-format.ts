import { formatDate, formatMoney, numberFormat, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';

/** Report result model as returned by /v1/reports/* (see apps/api/src/modules/reports/types.ts). */
export type ColumnType = 'text' | 'enum' | 'integer' | 'decimal' | 'percent' | 'money' | 'date' | 'minutes' | 'boolean';
export interface ReportColumn {
  key: string;
  labelKey: string;
  subLabelKey?: string;
  type: ColumnType;
  enumKey?: string;
  scale?: number;
  sensitive?: boolean;
}
export interface MoneyCell {
  amountMinor: string;
  currency: string;
}
export type Cell = string | number | boolean | MoneyCell | null;
export interface ReportResult {
  title: string;
  parameters: string[];
  generatedAt: string;
  columns: ReportColumn[];
  rows: Array<Record<string, Cell>>;
  totals?: Array<Record<string, Cell>>;
  chart?: { type: 'bar' | 'line'; x: string; y: string[] };
  notes: string[];
  facts?: Array<{ key: string; labelKey: string; type: ColumnType; value: Cell; enumKey?: string }>;
  restricted?: number;
  sensitive?: boolean;
  truncated?: boolean;
}

const isMoney = (v: Cell): v is MoneyCell => !!v && typeof v === 'object' && 'amountMinor' in v;
export const NUMERIC: ColumnType[] = ['integer', 'decimal', 'percent', 'money', 'minutes'];

/** Header text, e.g. "Asian – Female" for a compound EEO-1 column. */
export function headerOf(t: (k: string) => string, c: Pick<ReportColumn, 'labelKey' | 'subLabelKey'>): string {
  return c.subLabelKey ? `${t(c.labelKey)} – ${t(c.subLabelKey)}` : t(c.labelKey);
}

/** Locale-aware display text; money stays integer minor units until formatting. */
export function displayCell(t: (k: string) => string, locale: Locale, c: Pick<ReportColumn, 'type' | 'scale' | 'enumKey'>, v: Cell): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (c.type) {
    case 'integer':
      return numberFormat(locale).format(Number(v));
    case 'decimal':
      return numberFormat(locale, { minimumFractionDigits: c.scale ?? 2, maximumFractionDigits: c.scale ?? 2 }).format(String(v) as unknown as number);
    case 'percent':
      return `${numberFormat(locale, { minimumFractionDigits: c.scale ?? 2, maximumFractionDigits: c.scale ?? 2 }).format(String(v) as unknown as number)}%`;
    case 'money':
      return isMoney(v) ? formatMoney(money(BigInt(v.amountMinor), v.currency), locale) : String(v);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? formatDate(String(v), locale) : String(v);
    case 'minutes':
      return `${numberFormat(locale, { maximumFractionDigits: 2 }).format(Number(v) / 60)} ${t('reports.hoursSuffix')}`;
    case 'boolean':
      return t(v ? 'common.yes' : 'common.no');
    case 'enum': {
      if (!c.enumKey) return String(v);
      const key = `${c.enumKey}.${v}`;
      const label = t(key);
      return label === key ? String(v) : label;
    }
    default:
      return String(v);
  }
}

/** Numeric value for chart geometry only (display text always comes from displayCell). */
export function chartValue(v: Cell): number {
  if (v === null || v === undefined) return 0;
  if (isMoney(v)) return Number(v.amountMinor);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
