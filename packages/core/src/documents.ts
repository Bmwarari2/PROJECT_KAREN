/**
 * Document templates and signing (ADR-0194 to ADR-0197), shared by the API, which renders PDFs in the home
 * region, and the web app, whose template editor shows a live preview. No I/O and no message catalogues here:
 * labels are looked up by the caller (`docFields.<key>` in the catalogues), so the web bundle stays small.
 */

// ---- signing ---------------------------------------------------------------------------------------------

/** Who signs first. The employee signs first by default (ADR-0187); templates and each send can change it. */
export const SIGNING_ORDERS = ['employee_first', 'company_first', 'any'] as const;
export type SigningOrder = (typeof SIGNING_ORDERS)[number];
export const isSigningOrder = (v: unknown): v is SigningOrder =>
  typeof v === 'string' && (SIGNING_ORDERS as readonly string[]).includes(v);

export type SigningParty = 'employee' | 'company';

/** Boxes HR may place on an uploaded PDF, and where on the page (a 3 × 3 grid, so it works by keyboard). */
export const FIELD_KINDS = ['signature', 'date'] as const;
export type PlacedFieldKind = (typeof FIELD_KINDS)[number];
export const FIELD_POSITIONS = [
  'top_left',
  'top_centre',
  'top_right',
  'middle_left',
  'middle_centre',
  'middle_right',
  'bottom_left',
  'bottom_centre',
  'bottom_right',
] as const;
export type FieldPosition = (typeof FIELD_POSITIONS)[number];
export interface PlacedField {
  party: SigningParty;
  kind: PlacedFieldKind;
  /** 1-based page number. */
  page: number;
  position: FieldPosition;
}

/** The page where HR prepares and sends a document for a person (16.11); task actions link here (16.14). */
export function newDocumentHref(o: {
  employeeId: string;
  templateId?: string | null;
  taskId?: string | null;
  documentId?: string | null;
}): string {
  const q = new URLSearchParams();
  if (o.templateId) q.set('template', o.templateId);
  if (o.documentId) q.set('document', o.documentId);
  if (o.taskId) q.set('task', o.taskId);
  const s = q.toString();
  return `/app/people/${encodeURIComponent(o.employeeId)}/documents/new${s ? `?${s}` : ''}`;
}

// ---- merge fields ----------------------------------------------------------------------------------------

export const FIELD_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Fields typed in when sending (`{{ask.<key>}}`), declared on the template version. */
export interface AskField {
  key: string;
  label: string;
  required: boolean;
}
export const ASK_PREFIX = 'ask.';
export const ASK_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

export type FieldGroup =
  'employee' | 'job' | 'contract' | 'pay' | 'leave' | 'manager' | 'employer' | 'document';

/**
 * Every merge field the system can fill from data it already holds. Labels are `docFields.<key>`.
 * Not offered, because the data is not held (ADR-0194): the date continuous employment began (it can differ from
 * the start date), and a separate employee notice period; templates ask for them when sending instead.
 */
export const MERGE_FIELDS: ReadonlyArray<{ key: string; group: FieldGroup }> = [
  { key: 'employee.displayName', group: 'employee' },
  { key: 'employee.firstName', group: 'employee' },
  { key: 'employee.lastName', group: 'employee' },
  { key: 'employee.employeeNumber', group: 'employee' },
  { key: 'employee.workEmail', group: 'employee' },
  { key: 'employee.jobTitle', group: 'job' },
  { key: 'employee.department', group: 'job' },
  { key: 'employee.location', group: 'job' },
  { key: 'employee.startDate', group: 'job' },
  { key: 'employee.employmentType', group: 'job' },
  { key: 'employee.weeklyHours', group: 'job' },
  { key: 'employee.workPattern', group: 'job' },
  { key: 'contract.type', group: 'contract' },
  { key: 'contract.noticePeriod', group: 'contract' },
  { key: 'contract.probationEndDate', group: 'contract' },
  { key: 'employee.salary', group: 'pay' },
  { key: 'employee.payFrequency', group: 'pay' },
  { key: 'pay.rate', group: 'pay' },
  { key: 'pay.schedule', group: 'pay' },
  { key: 'pay.nextPayDate', group: 'pay' },
  { key: 'leave.annualEntitlement', group: 'leave' },
  { key: 'leave.yearStart', group: 'leave' },
  { key: 'manager.name', group: 'manager' },
  { key: 'manager.jobTitle', group: 'manager' },
  { key: 'company.name', group: 'employer' },
  { key: 'entity.name', group: 'employer' },
  { key: 'entity.address', group: 'employer' },
  { key: 'entity.registrationNumber', group: 'employer' },
  { key: 'today', group: 'document' },
];
export const FIELD_GROUPS: FieldGroup[] = [
  'employee',
  'job',
  'contract',
  'pay',
  'leave',
  'manager',
  'employer',
  'document',
];
const KNOWN = new Set(MERGE_FIELDS.map((f) => f.key));
export const isKnownField = (key: string, ask: readonly AskField[] = []) =>
  KNOWN.has(key) || (key.startsWith(ASK_PREFIX) && ask.some((a) => `${ASK_PREFIX}${a.key}` === key));

/** The merge fields a template body uses, in order of first use. */
export function fieldsIn(body: string): string[] {
  return [...new Set([...body.matchAll(FIELD_PATTERN)].map((m) => m[1]!))];
}
/** Fields the body uses that are neither known nor declared as ask-when-sending fields. */
export function unknownFields(body: string, ask: readonly AskField[] = []): string[] {
  return fieldsIn(body).filter((k) => !isKnownField(k, ask));
}

/** Text split into literal parts and merge fields, for previews that mark the fields. */
export function splitFields(text: string): Array<string | { field: string }> {
  const out: Array<string | { field: string }> = [];
  let last = 0;
  for (const m of text.matchAll(FIELD_PATTERN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ field: m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---- simple formatting -----------------------------------------------------------------------------------

/** A run of text, bold or not. */
export interface Run {
  text: string;
  bold: boolean;
}
/**
 * The formatting templates support (16.9): headings (`#`, `##`), paragraphs (blank lines between them; a single
 * line break stays a line break), bulleted (`-`) and numbered (`1.`) lists, and `**bold**`.
 */
export type Block =
  | { type: 'heading'; level: 1 | 2; runs: Run[] }
  | { type: 'paragraph'; lines: Run[][] }
  | { type: 'list'; ordered: boolean; items: Array<{ marker: string; runs: Run[] }> };

/** `**bold**` spans; an unmatched `**` stays as it is. */
export function parseInline(s: string): Run[] {
  const runs: Run[] = [];
  const parts = s.split('**');
  if (parts.length % 2 === 0) return s ? [{ text: s, bold: false }] : [];
  parts.forEach((p, i) => {
    if (p) runs.push({ text: p, bold: i % 2 === 1 });
  });
  return runs;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

export function parseMarkup(body: string): Block[] {
  const blocks: Block[] = [];
  let para: Run[][] | null = null;
  let list: Extract<Block, { type: 'list' }> | null = null;
  const end = () => {
    if (para) blocks.push({ type: 'paragraph', lines: para });
    if (list) blocks.push(list);
    para = null;
    list = null;
  };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      end();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      end();
      blocks.push({ type: 'heading', level: h[1]!.length === 1 ? 1 : 2, runs: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      const ordered = !!n;
      if (para || (list && list.ordered !== ordered)) end();
      list ??= { type: 'list', ordered, items: [] };
      list.items.push({ marker: n ? `${n[1]}.` : '•', runs: parseInline((b ? b[1] : n![2])!) });
      continue;
    }
    if (list) end();
    (para ??= []).push(parseInline(line));
  }
  end();
  return blocks;
}

/** Replaces merge fields in every run (after parsing, so a value never becomes formatting). */
export function mergeBlocks(blocks: Block[], value: (key: string) => string): Block[] {
  const runs = (rs: Run[]) =>
    rs.map((r) => ({ ...r, text: r.text.replace(FIELD_PATTERN, (_, k: string) => value(k)) }));
  return blocks.map((b) =>
    b.type === 'heading'
      ? { ...b, runs: runs(b.runs) }
      : b.type === 'paragraph'
        ? { ...b, lines: b.lines.map(runs) }
        : { ...b, items: b.items.map((i) => ({ ...i, runs: runs(i.runs) })) },
  );
}

// ---- the fictional sample person (template preview) ------------------------------------------------------

/**
 * Raw values for the editor's live preview: a fictional person. Words are message keys resolved by the caller;
 * dates and money are formatted by the caller for the viewer's locale.
 */
export const SAMPLE_PERSON = {
  'employee.displayName': 'Alex Example',
  'employee.firstName': 'Alex',
  'employee.lastName': 'Example',
  'employee.employeeNumber': 'E-00042',
  'employee.workEmail': 'alex.example@example.test',
  'employee.jobTitle': 'Warehouse supervisor',
  'employee.department': 'Operations',
  'employee.location': 'North depot',
  'entity.name': 'Example Trading Ltd',
  'entity.address': '1 Sample Street, Exampletown, ZZ1 1ZZ',
  'entity.registrationNumber': '00000000',
  'company.name': 'Example Trading',
  'manager.name': 'Sam Sample',
  'manager.jobTitle': 'Operations manager',
  'employee.weeklyHours': '37.5',
} as const;
export const SAMPLE_DATES = {
  'employee.startDate': '2026-11-02',
  'contract.probationEndDate': '2027-05-02',
  'pay.nextPayDate': '2026-11-27',
  'leave.yearStart': '2026-01-01',
} as const;
export const SAMPLE_ENUMS = {
  'employee.employmentType': ['reports.enum.employmentType', 'full_time'],
  'contract.type': ['reports.enum.contractType', 'permanent'],
  'employee.payFrequency': ['reports.enum.payFrequency', 'annual'],
  'pay.schedule': ['docFields.value.schedule', 'monthly'],
} as const;

// ---- values in words ---------------------------------------------------------------------------------------

/** A caller's translation function: the API's `t(locale, …)` or the web app's scoped `t`. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Loc = 'en-GB' | 'en-US';
const unit = (value: number, u: 'day' | 'week' | 'hour', locale: Loc) =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: u,
    unitDisplay: 'long',
    maximumFractionDigits: 2,
  }).format(value);
const num = (value: number, locale: Loc) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);

/** A notice period held in days, in weeks when it is whole weeks ("4 weeks", "30 days"). */
export function noticeInWords(days: number, locale: Loc): string {
  return days > 0 && days % 7 === 0 ? unit(days / 7, 'week', locale) : unit(days, 'day', locale);
}

/** Hours per ISO weekday (1 = Monday … 7 = Sunday). */
export type WeekPattern = Partial<Record<'1' | '2' | '3' | '4' | '5' | '6' | '7', number>>;

/** "Monday, Tuesday, Wednesday, Thursday and Friday (37.5 hours a week)". */
export function patternInWords(pattern: WeekPattern, locale: Loc, tr: Translate): string {
  const days = (['1', '2', '3', '4', '5', '6', '7'] as const).filter((d) => (pattern[d] ?? 0) > 0);
  if (!days.length) return '';
  // 1 January 2024 was a Monday: names only, formatted in UTC (no date arithmetic)
  const name = (d: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, Number(d))),
    );
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(days.map(name));
  const hours = days.reduce((s, d) => s + (pattern[d] ?? 0), 0);
  return tr('docFields.value.pattern', { days: list, hours: num(hours, locale) });
}

export function hoursInWords(hours: number, locale: Loc, tr: Translate): string {
  return tr('docFields.value.weeklyHours', { hours: num(hours, locale) });
}

/** Annual holiday entitlement from the leave policy: days or hours a year, or an accrual rate. */
export function entitlementInWords(
  e: { kind: 'days' | 'hours'; amount: number } | { kind: 'percent'; amount: number },
  locale: Loc,
  tr: Translate,
): string {
  if (e.kind === 'percent') return tr('docFields.value.accrual', { percent: num(e.amount, locale) });
  return tr('docFields.value.perYear', {
    amount: unit(e.amount, e.kind === 'days' ? 'day' : 'hour', locale),
  });
}

/** "£30,000.00 a year" from a formatted amount and the pay basis (annual, monthly, weekly, daily, hourly). */
export function rateInWords(amount: string, basis: string, tr: Translate): string {
  return tr(`docFields.value.rate.${basis}`, { amount });
}

/** A postal address held as JSON (line1, line2, city, region, postcode, country) on one line. */
export function addressInWords(a: Record<string, unknown> | null | undefined): string {
  if (!a) return '';
  return ['line1', 'line2', 'line3', 'city', 'region', 'postcode']
    .map((k) => (typeof a[k] === 'string' ? (a[k] as string).trim() : ''))
    .filter(Boolean)
    .join(', ');
}
