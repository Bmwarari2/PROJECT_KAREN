/**
 * Task actions (ADR-0191): the one registry of what a task's main button does. Every task may carry an
 * action — a kind and its parameters — that gives it
 *  - a main button label (a message-catalogue key);
 *  - the page that does the work, with the person the task is about already chosen;
 *  - the record whose completion closes the task (ADR-0192), from which the API also reads a live status.
 *
 * The API (task pages, workflow templates, completion), the worker and the web app (task page, workflow
 * editor's action picker) all read this module, so a kind behaves the same everywhere. It is pure and
 * light on purpose (no time library), because the web app loads it on the task page.
 *
 * Extension point: later parts fill in the placeholder kinds. A placeholder (`landed: false`) already has
 * its final `href` (the contract its owning part builds) and a `fallback` — a generic action on a page
 * that exists today — so a task never leads to a missing page. When the owning part's page lands, it sets
 * `landed: true` on its kind; `apps/web/test/task-actions-routes.test.ts` fails if a landed href (or any
 * fallback) does not match a route of the web app.
 */
import {
  isTargetType,
  personHref,
  PROFILE_TABS,
  safeAppLink,
  targetHref,
  type ProfileTab,
  type TargetType,
} from './links';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export const TASK_ACTION_KINDS = [
  // generic kinds, built with this registry
  'open_link',
  'open_person',
  'open_record',
  // placeholder kinds, filled in by the parts that own their pages (PROGRESS.md Phase 16)
  'send_document',
  'rtw_check',
  'i9_section1',
  'i9_section2',
  'i9_reverify',
  'compliance_renewal',
  'payroll_starter',
  'payroll_leaver',
  'form',
  'it_request',
  'access_removal',
] as const;
export type TaskActionKind = (typeof TASK_ACTION_KINDS)[number];

/** Structured forms a `form` action opens (Phase 16 part G); a new form kind is added here. */
export const FORM_KINDS = [
  'return_to_work',
  'exit_interview',
  'probation_review',
  'check_in',
  'first_week_plan',
  'handover',
  'transfer_welcome',
] as const;
export type FormKind = (typeof FORM_KINDS)[number];

/** Labels an `open_link` button may use (a link names what it opens, never free text). */
export const OPEN_LINK_LABELS = ['open', 'sign', 'review', 'details'] as const;
export type OpenLinkLabel = (typeof OPEN_LINK_LABELS)[number];

type None = Record<string, never>;
export interface TaskActionParams {
  /** A page of the app (a relative `/app` path, never an absolute URL). */
  open_link: { href: string; label?: OpenLinkLabel };
  /** The person the task is about, on one of their profile's tabs. */
  open_person: { tab?: ProfileTab };
  /** A record's own page (the deep-link map, ADR-0160). */
  open_record: { type: TargetType; id: string };
  /** Prepare a document from a template and send it for signature (part C). */
  send_document: { templateId?: string };
  rtw_check: None;
  i9_section1: None;
  i9_section2: None;
  i9_reverify: None;
  /** Renew a compliance-matrix requirement, or record a missing one (part E). */
  compliance_renewal: { requirementId?: string };
  payroll_starter: None;
  payroll_leaver: None;
  form: { formKind: FormKind };
  it_request: None;
  access_removal: None;
}
export type TaskAction = { [K in TaskActionKind]: { kind: K; params: TaskActionParams[K] } }[TaskActionKind];

/**
 * Records that close tasks (ADR-0192). Where an obligation belongs to a person rather than to a stored row
 * (a right-to-work check still to be made, Section 2 of a Form I-9, a starter's payroll checklist) the
 * record id is the person's employee id; `compliance_requirement` and `document_send` ids are the
 * requirement and the template, matched together with the person the task is about.
 */
export const TASK_RECORD_TYPES = [
  'approval_request',
  'signature_request',
  'document',
  'document_send',
  'asset_acknowledgement',
  'asset_return',
  'right_to_work',
  'rtw_check',
  'i9_section1',
  'i9_section2',
  'i9_reverify',
  'compliance_record',
  'compliance_requirement',
  'return_to_work',
  'hr_request',
  'payroll_starter',
  'payroll_leaver',
  'it_request',
  'access_removal',
  ...FORM_KINDS.map((k) => `form.${k}` as const),
] as const;
export type TaskRecordType = (typeof TASK_RECORD_TYPES)[number];
export interface TaskRecordRef {
  type: TaskRecordType;
  id: string;
}
export const isTaskRecordType = (v: unknown): v is TaskRecordType =>
  typeof v === 'string' && (TASK_RECORD_TYPES as readonly string[]).includes(v);

/**
 * Record types whose owning module closes their tasks today (it calls `completeTasksFor` when the record
 * completes). A task page says "closes by itself" only for these. A part adds its record types here when
 * it wires them; `packages/core/test/task-actions.test.ts` checks each has a closing call in the API, and
 * `apps/api/test/task-actions.int.test.ts` proves it end to end.
 */
export const RECORD_TYPES_CLOSED_TODAY: readonly TaskRecordType[] = [
  'approval_request',
  'signature_request',
  'asset_acknowledgement',
  'asset_return',
  'right_to_work',
  'rtw_check',
  'i9_section1',
  'i9_section2',
  'i9_reverify',
  'compliance_record',
  'compliance_requirement',
  'return_to_work',
  'hr_request',
];
export const closesItself = (recordType: unknown): boolean =>
  isTaskRecordType(recordType) && RECORD_TYPES_CLOSED_TODAY.includes(recordType);

/** What a kind needs to build its page: the task and the person it is about. */
export interface TaskActionContext {
  taskId: string;
  subjectEmployeeId: string | null;
}

/** The parts of the product that own a kind's page (for the ADR and the editor's grouping). */
export type TaskActionOwner = 'tasks' | 'documents' | 'compliance' | 'payroll' | 'forms' | 'it';

export interface TaskActionKindDef<K extends TaskActionKind = TaskActionKind> {
  kind: K;
  owner: TaskActionOwner;
  /** True once the owning part's page exists; until then the button uses `fallback`. */
  landed: boolean;
  /** Offered in the workflow editor's action picker. */
  pickable: boolean;
  /** The permission the page asks for (access catalogue), beyond being able to see the task. */
  permission?: string;
  /** Validates and normalises untrusted parameters (API bodies, stored JSON); null when invalid. */
  parse(raw: unknown): TaskActionParams[K] | null;
  /** Catalogue key of the main button. */
  label(params: TaskActionParams[K]): string;
  /** The page that does the work, with the person already chosen; null when the context lacks it. */
  href(params: TaskActionParams[K], ctx: TaskActionContext): string | null;
  /** A generic action on a page that exists today, used until the kind lands. */
  fallback?(params: TaskActionParams[K], ctx: TaskActionContext): TaskAction | null;
  /** The record whose completion closes a task of this kind (none: closed by hand or by task id). */
  record?(params: TaskActionParams[K], ctx: TaskActionContext): TaskRecordRef | null;
}

const none = (raw: unknown): None | null => (raw === undefined || isObject(raw) ? {} : null);
const q = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};
/** A person-scoped page: needs the person the task is about. */
const forPerson =
  (build: (employeeId: string, ctx: TaskActionContext) => string) =>
  (_p: unknown, ctx: TaskActionContext): string | null =>
    ctx.subjectEmployeeId ? build(encodeURIComponent(ctx.subjectEmployeeId), ctx) : null;
const personRecord =
  (type: TaskRecordType) =>
  (_p: unknown, ctx: TaskActionContext): TaskRecordRef | null =>
    ctx.subjectEmployeeId ? { type, id: ctx.subjectEmployeeId } : null;
const profile = (tab?: ProfileTab): TaskAction => ({
  kind: 'open_person',
  params: tab && tab !== 'overview' ? { tab } : {},
});

/** Link targets whose page is also the record that closes the task. */
const RECORD_OF_TARGET: Partial<Record<TargetType, TaskRecordType>> = {
  approval_request: 'approval_request',
  document: 'document',
  rtw_check: 'rtw_check',
  asset_assignment: 'asset_acknowledgement',
  asset_return: 'asset_return',
  hr_request: 'hr_request',
};

const DEFS: { [K in TaskActionKind]: TaskActionKindDef<K> } = {
  open_link: {
    kind: 'open_link',
    owner: 'tasks',
    landed: true,
    pickable: true,
    parse(raw) {
      if (!isObject(raw)) return null;
      const href = safeAppLink(typeof raw.href === 'string' ? raw.href.trim() : null);
      if (!href || href.length > 500 || /\s/.test(href)) return null;
      const label = raw.label;
      if (label !== undefined && !(OPEN_LINK_LABELS as readonly unknown[]).includes(label)) return null;
      return label ? { href, label: label as OpenLinkLabel } : { href };
    },
    label: (p) => `taskActions.button.link.${p.label ?? 'open'}`,
    href: (p) => safeAppLink(p.href),
  },
  open_person: {
    kind: 'open_person',
    owner: 'tasks',
    landed: true,
    pickable: true,
    parse(raw) {
      if (raw === undefined) return {};
      if (!isObject(raw)) return null;
      if (raw.tab === undefined) return {};
      return (PROFILE_TABS as readonly unknown[]).includes(raw.tab) ? { tab: raw.tab as ProfileTab } : null;
    },
    label: (p) => `taskActions.button.person.${p.tab ?? 'overview'}`,
    href: (p, ctx) => (ctx.subjectEmployeeId ? personHref(ctx.subjectEmployeeId, p.tab) : null),
  },
  open_record: {
    kind: 'open_record',
    owner: 'tasks',
    landed: true,
    // a template has no record yet: records are linked by the module that creates the task
    pickable: false,
    parse(raw) {
      if (!isObject(raw) || !isTargetType(raw.type) || !isUuid(raw.id)) return null;
      return { type: raw.type, id: raw.id.toLowerCase() };
    },
    label: (p) => `taskActions.button.record.${p.type}`,
    href: (p) => targetHref(p),
    record: (p) => {
      const type = RECORD_OF_TARGET[p.type];
      return type ? { type, id: p.id } : null;
    },
  },
  send_document: {
    kind: 'send_document',
    owner: 'documents',
    landed: false,
    pickable: true,
    permission: 'documents.manage',
    parse(raw) {
      if (raw === undefined) return {};
      if (!isObject(raw)) return null;
      if (raw.templateId === undefined || raw.templateId === null || raw.templateId === '') return {};
      return isUuid(raw.templateId) ? { templateId: raw.templateId.toLowerCase() } : null;
    },
    label: () => 'taskActions.button.send_document',
    // the contract part C builds: the send screen for this person and template, told which task to close
    href: (p, ctx) =>
      forPerson((e) => `/app/people/${e}/documents/new${q({ template: p.templateId, task: ctx.taskId })}`)(
        p,
        ctx,
      ),
    fallback: () => profile('documents'),
    record: (p, ctx) =>
      p.templateId && ctx.subjectEmployeeId ? { type: 'document_send', id: p.templateId } : null,
  },
  rtw_check: {
    kind: 'rtw_check',
    owner: 'compliance',
    landed: false,
    pickable: true,
    permission: 'compliance.record',
    parse: none,
    label: () => 'taskActions.button.rtw_check',
    href: forPerson((e, ctx) => `/app/compliance/right-to-work${q({ record: e, task: ctx.taskId })}`),
    fallback: () => profile('compliance'),
    record: personRecord('right_to_work'),
  },
  i9_section1: {
    kind: 'i9_section1',
    owner: 'compliance',
    landed: false,
    pickable: true,
    parse: none,
    label: () => 'taskActions.button.i9_section1',
    // the employee completes Section 1 in self-service
    href: (_p, ctx) => `/app/me/i9${q({ task: ctx.taskId })}`,
    // the joiner's checklist, at this step
    fallback: (_p, ctx) => ({ kind: 'open_link', params: { href: `/app/welcome#task-${ctx.taskId}` } }),
    record: personRecord('i9_section1'),
  },
  i9_section2: {
    kind: 'i9_section2',
    owner: 'compliance',
    landed: false,
    pickable: true,
    permission: 'compliance.record',
    parse: none,
    label: () => 'taskActions.button.i9_section2',
    href: forPerson((e, ctx) => `/app/compliance/i9${q({ record: e, section: '2', task: ctx.taskId })}`),
    fallback: () => profile('compliance'),
    record: personRecord('i9_section2'),
  },
  i9_reverify: {
    kind: 'i9_reverify',
    owner: 'compliance',
    landed: false,
    pickable: true,
    permission: 'compliance.record',
    parse: none,
    label: () => 'taskActions.button.i9_reverify',
    href: forPerson((e, ctx) => `/app/compliance/i9${q({ record: e, reverify: '1', task: ctx.taskId })}`),
    fallback: () => profile('compliance'),
    record: personRecord('i9_reverify'),
  },
  compliance_renewal: {
    kind: 'compliance_renewal',
    owner: 'compliance',
    landed: false,
    pickable: true,
    permission: 'compliance.record',
    parse(raw) {
      if (raw === undefined) return {};
      if (!isObject(raw)) return null;
      if (raw.requirementId === undefined || raw.requirementId === '') return {};
      return isUuid(raw.requirementId) ? { requirementId: raw.requirementId.toLowerCase() } : null;
    },
    label: () => 'taskActions.button.compliance_renewal',
    href: (p, ctx) =>
      forPerson(
        (e) => `/app/compliance/matrix${q({ record: e, requirement: p.requirementId, task: ctx.taskId })}`,
      )(p, ctx),
    fallback: () => profile('compliance'),
    record: (p) => (p.requirementId ? { type: 'compliance_requirement', id: p.requirementId } : null),
  },
  payroll_starter: {
    kind: 'payroll_starter',
    owner: 'payroll',
    landed: false,
    pickable: true,
    permission: 'payroll.manage',
    parse: none,
    label: () => 'taskActions.button.payroll_starter',
    href: forPerson((e, ctx) => `/app/payroll/starters/${e}${q({ task: ctx.taskId })}`),
    fallback: () => ({ kind: 'open_link', params: { href: '/app/payroll' } }),
    record: personRecord('payroll_starter'),
  },
  payroll_leaver: {
    kind: 'payroll_leaver',
    owner: 'payroll',
    landed: false,
    pickable: true,
    permission: 'payroll.manage',
    parse: none,
    label: () => 'taskActions.button.payroll_leaver',
    href: forPerson((e, ctx) => `/app/payroll/leavers/${e}${q({ task: ctx.taskId })}`),
    fallback: () => ({ kind: 'open_link', params: { href: '/app/payroll' } }),
    record: personRecord('payroll_leaver'),
  },
  form: {
    kind: 'form',
    owner: 'forms',
    landed: false,
    pickable: true,
    parse(raw) {
      if (!isObject(raw) || !(FORM_KINDS as readonly unknown[]).includes(raw.formKind)) return null;
      return { formKind: raw.formKind as FormKind };
    },
    label: (p) => `taskActions.button.form.${p.formKind}`,
    href: (p, ctx) =>
      forPerson((e) => `/app/forms/${p.formKind}/new${q({ employee: e, task: ctx.taskId })}`)(p, ctx),
    // a return-to-work conversation follows an absence: the person's time off is the closest page today
    fallback: (p) => profile(p.formKind === 'return_to_work' ? 'time-off' : 'overview'),
    record: (p, ctx) =>
      ctx.subjectEmployeeId ? { type: `form.${p.formKind}`, id: ctx.subjectEmployeeId } : null,
  },
  it_request: {
    kind: 'it_request',
    owner: 'it',
    landed: false,
    pickable: true,
    permission: 'assets.manage',
    parse: none,
    label: () => 'taskActions.button.it_request',
    href: forPerson((e, ctx) => `/app/it/requests/new${q({ employee: e, task: ctx.taskId })}`),
    fallback: () => ({ kind: 'open_link', params: { href: '/app/assets' } }),
    record: personRecord('it_request'),
  },
  access_removal: {
    kind: 'access_removal',
    owner: 'it',
    landed: false,
    pickable: true,
    parse: none,
    label: () => 'taskActions.button.access_removal',
    href: forPerson((e, ctx) => `/app/people/${e}/access${q({ task: ctx.taskId })}`),
    fallback: () => profile('overview'),
    record: personRecord('access_removal'),
  },
};

export const isTaskActionKind = (v: unknown): v is TaskActionKind =>
  typeof v === 'string' && (TASK_ACTION_KINDS as readonly string[]).includes(v);

/** A kind's definition. */
export function taskActionKind<K extends TaskActionKind>(kind: K): TaskActionKindDef<K> {
  return DEFS[kind] as TaskActionKindDef<K>;
}

/** Kinds the workflow editor's picker offers, in registry order. */
export const PICKABLE_TASK_ACTION_KINDS: TaskActionKind[] = TASK_ACTION_KINDS.filter((k) => DEFS[k].pickable);

/** Validates an action from untrusted input (`{ kind, params }`); null when the kind or params are invalid. */
export function parseTaskAction(raw: unknown): TaskAction | null {
  if (!isObject(raw) || !isTaskActionKind(raw.kind)) return null;
  const def = DEFS[raw.kind] as TaskActionKindDef;
  const params = def.parse(raw.params);
  return params ? ({ kind: raw.kind, params } as TaskAction) : null;
}

const call = <R>(
  action: TaskAction,
  f: <K extends TaskActionKind>(def: TaskActionKindDef<K>, params: TaskActionParams[K]) => R,
): R => f(DEFS[action.kind] as TaskActionKindDef, action.params as never);

/** The record that closes a task with this action (ADR-0192), if its kind links one. */
export function taskActionRecord(action: TaskAction, ctx: TaskActionContext): TaskRecordRef | null {
  return call(action, (def, params) => def.record?.(params, ctx) ?? null);
}

export interface ResolvedTaskAction {
  /** The kind the task asks for. */
  kind: TaskActionKind;
  /** The kind whose page the button opens (the kind itself, or its fallback's kind until it lands). */
  opens: TaskActionKind;
  /** Catalogue key of the button (the fallback's label when the fallback is used, so it stays truthful). */
  labelKey: string;
  href: string;
  /** False while the kind's own page has not landed and the button opens its fallback. */
  landed: boolean;
}

/** The main button of a task: its label and page, falling back to an existing page until the kind lands. */
export function resolveTaskAction(action: TaskAction, ctx: TaskActionContext): ResolvedTaskAction | null {
  const def = DEFS[action.kind] as TaskActionKindDef;
  if (def.landed) {
    const href = call(action, (d, p) => d.href(p, ctx));
    if (!href) return null;
    return {
      kind: action.kind,
      opens: action.kind,
      labelKey: call(action, (d, p) => d.label(p)),
      href,
      landed: true,
    };
  }
  const fallback = call(action, (d, p) => d.fallback?.(p, ctx) ?? null);
  if (!fallback || !DEFS[fallback.kind].landed) return null;
  const resolved = resolveTaskAction(fallback, ctx);
  return resolved ? { ...resolved, kind: action.kind, landed: false } : null;
}

/** The final page of a kind (its contract), whether or not it has landed. For tests and the ADR. */
export function taskActionContractHref(action: TaskAction, ctx: TaskActionContext): string | null {
  return call(action, (d, p) => d.href(p, ctx));
}

/** Catalogue key naming a kind in the workflow editor's picker. */
export const taskActionKindLabel = (kind: TaskActionKind) => `taskActions.kind.${kind}`;

// ---- due dates (ADR-0193) ------------------------------------------------------------------------------

/**
 * What a task's due date is counted from: the workflow's own date (`anchor`, what `dueOffsetDays` always
 * meant: the start date, the leaving date or the transfer date), or one of the person's own dates.
 */
export const DUE_ANCHORS = ['anchor', 'start', 'end', 'probation_end'] as const;
export type DueAnchor = (typeof DUE_ANCHORS)[number];

/**
 * Deadlines that come from a jurisdiction pack rule rather than from a number in a template: the API
 * resolves them from the pack for the person's jurisdiction (never from a value written here).
 */
export const PACK_DEADLINES = ['i9_section2'] as const;
export type PackDeadline = (typeof PACK_DEADLINES)[number];

export interface DueRule {
  anchor: DueAnchor;
  /** Days after the anchor date (negative: before it). Ignored when `packDeadline` is set. */
  offsetDays: number;
  /** Count business days (the workspace's business weekdays, skipping the pack's public holidays). */
  businessDays?: boolean;
  /** The deadline is the pack's (e.g. Form I-9 Section 2): the pack gives the count and the calendar. */
  packDeadline?: PackDeadline;
}

/** Validates a due rule from untrusted input; null when invalid. */
export function parseDueRule(raw: unknown): DueRule | null {
  if (!isObject(raw)) return null;
  if (!(DUE_ANCHORS as readonly unknown[]).includes(raw.anchor)) return null;
  const offset = raw.offsetDays;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < -365 || offset > 365) return null;
  if (raw.businessDays !== undefined && typeof raw.businessDays !== 'boolean') return null;
  if (raw.packDeadline !== undefined && !(PACK_DEADLINES as readonly unknown[]).includes(raw.packDeadline))
    return null;
  return {
    anchor: raw.anchor as DueAnchor,
    offsetDays: offset,
    ...(raw.businessDays ? { businessDays: true } : {}),
    ...(raw.packDeadline ? { packDeadline: raw.packDeadline as PackDeadline } : {}),
  };
}

/** A workflow task's due rule: its `due`, else its `dueOffsetDays` from the workflow's own date. */
export function dueRuleOf(def: { due?: unknown; dueOffsetDays?: number }): DueRule {
  const parsed = def.due === undefined ? null : parseDueRule(def.due);
  return parsed ?? { anchor: 'anchor', offsetDays: def.dueOffsetDays ?? 0 };
}

// ---- where a task comes from (ADR-0193) ----------------------------------------------------------------

/** Task sources ("Comes from"); `manual` remains for tasks made before sources were recorded. */
export const TASK_SOURCES = [
  'workflow',
  'approval',
  'automation',
  'document',
  'manual',
  'compliance',
  'hr_request',
  'absence',
  'asset',
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
