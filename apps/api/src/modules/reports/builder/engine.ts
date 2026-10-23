import { Type, type Static } from 'typebox';
import { can, canSome, type Principal } from '@thapsus/core/permissions';
import { compareDates } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { ApiError } from '../../../http/errors';
import { CivilDate } from '../../../http/schemas';
import { FieldGate, fieldVisibleSomewhere, paramAdder, readableSql, rowScope } from '../access';
import { RESTRICTED } from '../calc/people';
import { formatScaled, parseScaled } from '../fixed';
import type { Cell, ChartHint, Column, ReportResult, Row } from '../types';
import {
  DATASETS,
  dataset,
  GROUPABLE,
  NUMERIC,
  type Dataset,
  type DatasetField,
  type FieldType,
} from './datasets';

/** Report-builder specification (stored in saved reports; never contains row data). */
export const FilterSpec = Type.Object(
  {
    field: Type.String({ maxLength: 60 }),
    op: Type.Union(
      ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty', 'isNotEmpty'].map((o) =>
        Type.Literal(o),
      ),
    ),
    value: Type.Optional(
      Type.Union([
        Type.String({ maxLength: 200 }),
        Type.Number(),
        Type.Boolean(),
        Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 }),
      ]),
    ),
  },
  { additionalProperties: false },
);
export const BuilderSpec = Type.Object(
  {
    dataset: Type.Union(DATASETS.map((d) => Type.Literal(d.key))),
    columns: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 40 })),
    filters: Type.Optional(Type.Array(FilterSpec, { maxItems: 20 })),
    groupBy: Type.Optional(
      Type.Array(
        Type.Object(
          {
            field: Type.String({ maxLength: 60 }),
            granularity: Type.Optional(Type.Union([Type.Literal('month'), Type.Literal('year')])),
          },
          { additionalProperties: false },
        ),
        { maxItems: 2 },
      ),
    ),
    measures: Type.Optional(
      Type.Array(
        Type.Object(
          {
            fn: Type.Union(
              ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'].map((f) => Type.Literal(f)),
            ),
            field: Type.Optional(Type.String({ maxLength: 60 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 6 },
      ),
    ),
    sort: Type.Optional(
      Type.Object(
        { key: Type.String({ maxLength: 80 }), dir: Type.Union([Type.Literal('asc'), Type.Literal('desc')]) },
        { additionalProperties: false },
      ),
    ),
    asOf: Type.Optional(CivilDate),
    from: Type.Optional(CivilDate),
    to: Type.Optional(CivilDate),
    population: Type.Optional(Type.Union([Type.Literal('employed'), Type.Literal('all')])),
    chart: Type.Optional(Type.Union([Type.Literal('bar'), Type.Literal('line'), Type.Literal('none')])),
  },
  { additionalProperties: false },
);
type FilterOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isEmpty' | 'isNotEmpty';
interface Filter {
  field: string;
  op: FilterOp;
  value?: string | number | boolean | string[];
}
export interface Measure {
  fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
}
/** TypeScript view of the BuilderSpec schema above (kept explicit for readable types). */
export interface BuilderSpec {
  dataset: 'employees' | 'leave' | 'absence' | 'timesheets';
  columns?: string[];
  filters?: Filter[];
  groupBy?: Array<{ field: string; granularity?: 'month' | 'year' }>;
  measures?: Measure[];
  sort?: { key: string; dir: 'asc' | 'desc' };
  asOf?: string;
  from?: string;
  to?: string;
  population?: 'employed' | 'all';
  chart?: 'bar' | 'line' | 'none';
}
export type BuilderSpecStatic = Static<typeof BuilderSpec>;

export const PREVIEW_ROWS = 500;
export const MAX_EXPORT_ROWS = 250_000;

const typeToColumn: Record<FieldType, Column['type']> = {
  text: 'text',
  enum: 'enum',
  integer: 'integer',
  decimal: 'decimal',
  money: 'money',
  date: 'date',
  minutes: 'minutes',
  boolean: 'boolean',
};
const enumKey = (f: DatasetField) => `reports.enum.${f.key}`;

// ---- catalogue -------------------------------------------------------------------------------------------

export interface CatalogueField {
  key: string;
  labelKey: string;
  type: FieldType;
  sensitivity: DatasetField['sensitivity'];
  enumValues?: readonly string[];
  groupable: boolean;
  aggregatable: boolean;
  vault: boolean;
}

/** Datasets and fields the principal may use: dataset by row permission, fields by field / vault permission. */
export function catalogueFor(p: Principal) {
  return DATASETS.filter((d) => canSome(p, d.permission)).map((d) => ({
    key: d.key,
    labelKey: `reports.dataset.${d.key}`,
    time: d.time,
    sensitivity: d.sensitivity,
    fields: d.fields
      .filter((f) => fieldAllowed(p, f))
      .map<CatalogueField>((f) => ({
        key: f.key,
        labelKey: `reports.field.${f.key}`,
        type: f.type,
        sensitivity: f.sensitivity,
        ...(f.enumValues ? { enumValues: f.enumValues } : {}),
        groupable: !f.vault && GROUPABLE.includes(f.type),
        aggregatable: !f.vault && NUMERIC.includes(f.type),
        vault: !!f.vault,
      })),
  }));
}

function fieldAllowed(p: Principal, f: DatasetField): boolean {
  if (f.vault) return canSome(p, `vault.read:${f.vault.category}`);
  return f.perm === null || fieldVisibleSomewhere(p, f.perm);
}

// ---- compilation -----------------------------------------------------------------------------------------

interface Compiled {
  sql: string;
  params: unknown[];
  columns: Column[];
  grouped: boolean;
  vaultColumns: DatasetField[];
  /** output column key → how to decode the SQL value */
  decoders: Array<{
    key: string;
    sqlKey: string;
    type: Column['type'];
    scale?: number;
    currencyKey?: string;
    group?: boolean;
  }>;
  chart?: ChartHint;
  sensitive: boolean;
  limit: number;
}

export interface CompileOptions {
  /** Default as-of date when the spec has none (today in the tenant's zone, from the caller). */
  defaultAsOf: string;
  limit: number;
}

function resolveField(d: Dataset, p: Principal, key: string): DatasetField {
  const f = d.fields.find((x) => x.key === key);
  if (!f || !fieldAllowed(p, f)) throw new ApiError('validation', `Unknown or unavailable field: ${key}`);
  return f;
}

export function compileSpec(p: Principal, spec: BuilderSpec, opts: CompileOptions): Compiled {
  const d = dataset(spec.dataset);
  if (!d || !canSome(p, d.permission)) throw new ApiError('forbidden');
  const params: unknown[] = [];
  const add = paramAdder(params);
  // date tokens become bound parameters only when some SQL actually uses them (no unused bind parameters)
  const values: Record<string, string> = {};
  if (d.time === 'asOf') values.asOf = spec.asOf ?? opts.defaultAsOf;
  else {
    if (!spec.from || !spec.to) throw new ApiError('validation', 'from and to are required for this dataset');
    if (compareDates(spec.from, spec.to) > 0) throw new ApiError('validation', 'from must not be after to');
    values.from = spec.from;
    values.to = spec.to;
  }
  const bound: Record<string, string> = {};
  const token = (k: string) => {
    if (!(k in values)) return 'NULL';
    return (bound[k] ??= `${add(values[k])}::date`);
  };
  const sub = (s: string) => s.replace(/\{(asOf|from|to)\}/g, (_, k: string) => token(k));

  const groupBy = spec.groupBy ?? [];
  const measures = spec.measures ?? [];
  const grouped = groupBy.length > 0 || measures.length > 0;
  const columnKeys = grouped ? [] : spec.columns?.length ? spec.columns : ['displayName'];
  const filters = spec.filters ?? [];

  const used = new Map<string, DatasetField>();
  const use = (key: string) => {
    const f = resolveField(d, p, key);
    used.set(key, f);
    return f;
  };
  const vaultColumns: DatasetField[] = [];
  for (const k of columnKeys) {
    const f = use(k);
    if (f.vault) vaultColumns.push(f);
  }
  for (const g of groupBy) {
    const f = use(g.field);
    if (f.vault || !GROUPABLE.includes(f.type))
      throw new ApiError('validation', `Cannot group by ${g.field}`);
    if (g.granularity && f.type !== 'date')
      throw new ApiError('validation', `Granularity needs a date field: ${g.field}`);
  }
  let moneyField: DatasetField | undefined;
  for (const m of measures) {
    if (m.fn === 'count') continue;
    if (!m.field) throw new ApiError('validation', `${m.fn} needs a field`);
    const f = use(m.field);
    if (f.vault) throw new ApiError('validation', `Cannot aggregate ${m.field}`);
    if ((m.fn === 'sum' || m.fn === 'avg') && !NUMERIC.includes(f.type))
      throw new ApiError('validation', `Cannot ${m.fn} ${m.field}`);
    if ((m.fn === 'min' || m.fn === 'max') && !NUMERIC.includes(f.type) && f.type !== 'date')
      throw new ApiError('validation', `Cannot ${m.fn} ${m.field}`);
    if (f.type === 'money' && m.fn !== 'countDistinct') {
      if (moneyField && moneyField.key !== f.key)
        throw new ApiError('validation', 'Only one money field can be aggregated at a time');
      moneyField = f;
    }
  }
  for (const flt of filters) {
    const f = use(flt.field);
    if (f.vault) throw new ApiError('validation', `Cannot filter on ${flt.field}`);
  }

  // joins needed by the used fields (with their prerequisites, in declaration order)
  const needed = new Set<string>();
  const need = (j: string) => {
    for (const r of d.joins[j]?.requires ?? []) need(r);
    needed.add(j);
  };
  for (const f of used.values()) for (const j of f.joins ?? []) need(j);
  const joins = Object.entries(d.joins)
    .filter(([k]) => needed.has(k))
    .map(([, j]) => sub(j.sql));

  // masked columns: CASE WHEN <readable for this row> THEN <value> END, plus the readability flag
  const select: string[] = [
    'e.id AS "__eid"',
    `${d.rowIdSql ?? 'e.id'} AS "__rid"`,
    'e.entity_id AS "__ent"',
    'e.country AS "__cty"',
    'e.department_id AS "__dep"',
    'e.location_id AS "__loc"',
  ];
  const readableOf = new Map<string, string>();
  for (const [key, f] of used) {
    if (f.vault) continue;
    const readable = f.perm === null ? 'true' : readableSql(p, f.perm, add);
    readableOf.set(key, readable);
    select.push(`CASE WHEN ${readable} THEN ${sub(f.sql)} END AS "c_${key}"`, `(${readable}) AS "r_${key}"`);
    if (f.type === 'money')
      select.push(`CASE WHEN ${readable} THEN ${sub(f.currencySql!)} END AS "c_${key}__ccy"`);
  }
  const where = [rowScope(p, d.permission, params), ...d.where.map(sub)];
  if (d.key === 'employees' && (spec.population ?? 'employed') === 'employed')
    where.push(`e.start_date <= ${token('asOf')} AND (e.end_date IS NULL OR e.end_date >= ${token('asOf')})`);

  const outerWhere = filters.map((flt) => filterSql(flt, used.get(flt.field)!, add));
  const limit = Math.min(opts.limit, MAX_EXPORT_ROWS);
  const columns: Column[] = [];
  const decoders: Compiled['decoders'] = [];
  let sql: string;
  let chart: ChartHint | undefined;
  const base = `WITH base AS (SELECT ${select.join(', ')} FROM ${d.from} ${joins.join(' ')} WHERE ${where.join(' AND ')})`;
  const maskedOf = (keys: string[]) => (keys.length ? keys.map((k) => `"r_${k}"`).join(' AND ') : 'true');

  if (!grouped) {
    const outs: string[] = ['"__eid"', '"__rid"', '"__ent"', '"__cty"', '"__dep"', '"__loc"'];
    for (const k of columnKeys) {
      const f = used.get(k)!;
      columns.push({
        key: k,
        labelKey: `reports.field.${k}`,
        type: typeToColumn[f.type],
        ...(f.enumValues ? { enumKey: enumKey(f) } : {}),
        ...(f.scale !== undefined ? { scale: f.type === 'decimal' ? Math.min(f.scale, 2) : f.scale } : {}),
        ...(f.sensitivity === 'special' ? { sensitive: true } : {}),
      });
      if (f.vault) continue;
      outs.push(`"c_${k}"`);
      if (f.type === 'money') outs.push(`"c_${k}__ccy"`);
      decoders.push({
        key: k,
        sqlKey: `c_${k}`,
        type: typeToColumn[f.type],
        scale: f.scale,
        currencyKey: f.type === 'money' ? `c_${k}__ccy` : undefined,
      });
    }
    const nonVault = columnKeys.filter((k) => !used.get(k)!.vault);
    outs.push(`NOT (${maskedOf(nonVault)}) AS "__masked"`);
    const sortKey =
      spec.sort && columnKeys.includes(spec.sort.key) && !used.get(spec.sort.key)!.vault
        ? spec.sort
        : { key: nonVault[0] ?? '__eid', dir: 'asc' as const };
    const sortSql =
      sortKey.key === '__eid'
        ? '"__eid"'
        : `"c_${sortKey.key}" ${sortKey.dir.toUpperCase()} NULLS LAST, "__eid"`;
    sql = `${base} SELECT ${outs.join(', ')} FROM base${outerWhere.length ? ` WHERE ${outerWhere.join(' AND ')}` : ''} ORDER BY ${sortSql} LIMIT ${limit + 1}`;
  } else {
    const groupSql: string[] = [];
    const outs: string[] = [];
    groupBy.forEach((g, i) => {
      const f = used.get(g.field)!;
      const value = g.granularity
        ? `to_char(date_trunc('${g.granularity}', "c_${g.field}"), 'YYYY-MM-DD')`
        : `"c_${g.field}"::text`;
      const expr = `CASE WHEN "r_${g.field}" THEN ${value} ELSE '${RESTRICTED}' END`;
      groupSql.push(expr);
      outs.push(`${expr} AS "g${i}"`);
      const key = g.granularity ? `${g.field}_${g.granularity}` : g.field;
      columns.push({
        key,
        labelKey: `reports.field.${g.field}`,
        ...(g.granularity ? { subLabelKey: `reports.granularity.${g.granularity}` } : {}),
        type:
          f.type === 'date' ? 'date' : f.type === 'enum' ? 'enum' : f.type === 'boolean' ? 'boolean' : 'text',
        ...(f.enumValues ? { enumKey: enumKey(f) } : {}),
      });
      decoders.push({ key, sqlKey: `g${i}`, type: f.type === 'boolean' ? 'boolean' : 'text', group: true });
    });
    if (moneyField) {
      const expr = `"c_${moneyField.key}__ccy"`;
      groupSql.push(expr);
      outs.push(`${expr} AS "ccy"`);
    }
    const ms: Measure[] = measures.length ? measures : [{ fn: 'count' }];
    ms.forEach((m, i) => {
      const f = m.field ? used.get(m.field)! : undefined;
      const key = `${m.fn}_${m.field ?? 'rows'}`;
      let expr: string;
      let type: Column['type'] = 'integer';
      let scale: number | undefined;
      const col = f ? `"c_${f.key}"` : '';
      switch (m.fn) {
        case 'count':
          expr = 'count(*)';
          break;
        case 'countDistinct':
          expr = `count(DISTINCT ${col})`;
          break;
        case 'sum':
          expr = `sum(${col})`;
          type = f!.type === 'decimal' ? 'decimal' : (f!.type as Column['type']);
          scale = f!.type === 'decimal' ? 2 : undefined;
          break;
        case 'avg':
          // money and minutes keep integer units (rounded half away from zero); others 2 dp
          expr =
            f!.type === 'money' || f!.type === 'minutes' ? `round(avg(${col}))` : `round(avg(${col}), 2)`;
          type = f!.type === 'money' || f!.type === 'minutes' ? (f!.type as Column['type']) : 'decimal';
          scale = type === 'decimal' ? 2 : undefined;
          break;
        default:
          expr = `${m.fn}(${col})`;
          type =
            f!.type === 'date' ? 'date' : f!.type === 'decimal' ? 'decimal' : (f!.type as Column['type']);
          scale = f!.type === 'decimal' ? 2 : undefined;
      }
      outs.push(`${expr} AS "m${i}"`);
      columns.push({
        key,
        labelKey: `reports.measure.${m.fn}`,
        type,
        ...(scale !== undefined ? { scale } : {}),
      });
      decoders.push({ key, sqlKey: `m${i}`, type, scale, currencyKey: type === 'money' ? 'ccy' : undefined });
    });
    const maskKeys = [...groupBy.map((g) => g.field), ...ms.filter((m) => m.field).map((m) => m.field!)];
    outs.push(`count(*) FILTER (WHERE NOT (${maskedOf([...new Set(maskKeys)])})) AS "__masked"`);
    const sortIdx = spec.sort ? decoders.findIndex((x) => x.key === spec.sort!.key) : -1;
    const order =
      sortIdx >= 0
        ? `"${decoders[sortIdx]!.sqlKey}" ${spec.sort!.dir.toUpperCase()} NULLS LAST`
        : groupSql.length
          ? groupSql.map((_, i) => `${i + 1}`).join(', ')
          : '1';
    sql = `${base} SELECT ${outs.join(', ')} FROM base${outerWhere.length ? ` WHERE ${outerWhere.join(' AND ')}` : ''}${groupSql.length ? ` GROUP BY ${groupSql.map((_, i) => i + 1).join(', ')}` : ''} ORDER BY ${order} LIMIT ${limit + 1}`;
    const yKeys = decoders
      .filter((x) => !x.group && ['integer', 'decimal', 'minutes'].includes(x.type))
      .map((x) => x.key);
    if (groupBy.length && yKeys.length && spec.chart !== 'none')
      chart = {
        type:
          spec.chart === 'line' || (spec.chart === undefined && used.get(groupBy[0]!.field)!.type === 'date')
            ? 'line'
            : 'bar',
        x: columns[0]!.key,
        y: yKeys.slice(0, 3),
      };
  }
  if (moneyField && grouped)
    columns.splice(groupBy.length, 0, { key: 'currency', labelKey: 'reports.col.currency', type: 'text' });
  if (moneyField && grouped)
    decoders.splice(groupBy.length, 0, { key: 'currency', sqlKey: 'ccy', type: 'text' });
  const sensitive =
    d.sensitivity === 'special' || [...used.values()].some((f) => f.sensitivity === 'special');
  return { sql, params, columns, grouped, vaultColumns, decoders, chart, sensitive, limit };
}

function filterSql(f: Filter, field: DatasetField, add: (v: unknown) => string): string {
  const col = `"c_${field.key}"`;
  const readable = `"r_${field.key}"`;
  const cast =
    field.type === 'date'
      ? '::date'
      : field.type === 'boolean'
        ? '::boolean'
        : NUMERIC.includes(field.type)
          ? '::numeric'
          : '::text';
  const value = (v: unknown) => {
    if (v === undefined || v === null || Array.isArray(v))
      throw new ApiError('validation', `Filter ${field.key} needs a value`);
    if (field.type === 'money' && !/^-?\d+$/.test(String(v)))
      throw new ApiError('validation', 'Money filters use integer minor units');
    return `${add(String(v))}${cast}`;
  };
  const lhs = cast === '::text' ? `${col}::text` : col;
  switch (f.op) {
    case 'eq':
      return `${lhs} = ${value(f.value)}`;
    case 'neq':
      return `(${readable} AND ${lhs} IS DISTINCT FROM ${value(f.value)})`;
    case 'gt':
      return `${lhs} > ${value(f.value)}`;
    case 'gte':
      return `${lhs} >= ${value(f.value)}`;
    case 'lt':
      return `${lhs} < ${value(f.value)}`;
    case 'lte':
      return `${lhs} <= ${value(f.value)}`;
    case 'in': {
      if (!Array.isArray(f.value) || !f.value.length)
        throw new ApiError('validation', `Filter ${field.key} needs a list`);
      return `${col}::text = ANY(${add(f.value.map(String))}::text[])`;
    }
    case 'contains':
      if (field.type !== 'text')
        throw new ApiError('validation', `contains needs a text field: ${field.key}`);
      return `${col} ILIKE ${add(`%${String(f.value ?? '').replace(/[%_\\]/g, '\\$&')}%`)}`;
    case 'isEmpty':
      return `(${readable} AND ${col} IS NULL)`;
    case 'isNotEmpty':
      return `${col} IS NOT NULL`;
    default:
      throw new ApiError('validation', 'Unknown filter operator');
  }
}

// ---- execution -------------------------------------------------------------------------------------------

/** Decrypts vault values (subject + field pairs) on the WRITER and audits every value read; keyed `${subject}|${field}`. */
export type VaultReader = (
  category: string,
  pairs: Array<{ subject: string; field: string }>,
) => Promise<Map<string, string>>;

function decode(
  value: unknown,
  d: Compiled['decoders'][number],
  row: Record<string, unknown>,
  t: (k: string) => string,
): Cell {
  if (value === null || value === undefined) return null;
  if (d.group && value === RESTRICTED) return t('reports.group.restricted');
  switch (d.type) {
    case 'integer':
    case 'minutes':
      return Number(value);
    case 'decimal':
      return formatScaled(parseScaled(String(value), 4), 4, Math.min(d.scale ?? 2, 2));
    case 'money': {
      const ccy = d.currencyKey ? row[d.currencyKey] : null;
      return ccy
        ? { amountMinor: String(parseScaled(String(value), 0)), currency: String(ccy).trim() }
        : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true';
    case 'date':
      return String(value).slice(0, 10);
    default:
      return String(value);
  }
}

export interface RunOptions extends CompileOptions {
  vault?: VaultReader;
  t: (key: string) => string;
}

/** Runs a builder spec on the reporting reader (RLS + scope + field masking in SQL; vault values via the writer). */
export async function runSpec(
  tx: Tx,
  p: Principal,
  spec: BuilderSpec,
  opts: RunOptions,
): Promise<ReportResult & { truncated: boolean }> {
  const c = compileSpec(p, spec, opts);
  const raw = await tx.query<Record<string, unknown>>(c.sql, c.params);
  const truncated = raw.length > c.limit;
  const rows = raw.slice(0, c.limit);
  let restricted = 0;
  const out: Row[] = rows.map((r) => {
    const row: Row = {};
    for (const d of c.decoders) row[d.key] = decode(r[d.sqlKey], d, r, opts.t);
    restricted += c.grouped ? Number(r.__masked ?? 0) : r.__masked ? 1 : 0;
    return row;
  });
  if (!c.grouped && c.vaultColumns.length) {
    const gate = await FieldGate.create(tx, p);
    for (const f of c.vaultColumns) {
      const perm = `vault.read:${f.vault!.category}`;
      const fieldOf = (r: Record<string, unknown>) => f.vault!.field.replace('{rowId}', String(r.__rid));
      const allowed = new Set(
        rows
          .filter((r) =>
            can(
              p,
              perm,
              gate.target({
                id: String(r.__eid),
                entity_id: r.__ent as string,
                country: r.__cty as string,
                department_id: r.__dep as string,
                location_id: r.__loc as string,
              }),
            ),
          )
          .map((r) => String(r.__rid)),
      );
      const pairs = rows
        .filter((r) => allowed.has(String(r.__rid)))
        .map((r) => ({ subject: String(r.__eid), field: fieldOf(r) }));
      const values =
        pairs.length && opts.vault ? await opts.vault(f.vault!.category, pairs) : new Map<string, string>();
      rows.forEach((r, i) => {
        out[i]![f.key] = values.get(`${String(r.__eid)}|${fieldOf(r)}`) ?? null;
        if (!allowed.has(String(r.__rid))) restricted++;
      });
    }
  }
  return {
    columns: c.columns,
    rows: out,
    chart: c.chart,
    notes: [
      ...(restricted ? ['reports.note.restricted'] : []),
      ...(truncated ? ['reports.note.truncated'] : []),
    ],
    restricted,
    sensitive: c.sensitive || c.vaultColumns.length > 0,
    truncated,
  };
}
