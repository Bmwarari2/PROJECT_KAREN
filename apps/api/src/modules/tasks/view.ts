import type { Tx } from '@thapsus/db';
import { formatDate, t, type Locale } from '@thapsus/core/i18n';
import { personHref, safeAppLink, targetHref } from '@thapsus/core/links';
import { canSome, type Principal } from '@thapsus/core/permissions';
import {
  isTaskRecordType,
  parseTaskAction,
  resolveTaskAction,
  type ResolvedTaskAction,
  type TaskAction,
  type TaskRecordType,
} from '@thapsus/core/task-actions';

/**
 * What a task shows (ADR-0191 to ADR-0193): its title and description in the reader's locale, its main
 * button, the live status of the record it is linked to, and where it comes from. Text is rendered here, in
 * the caller's locale, so API clients and the web app read the same words.
 */
export type TaskRow = Record<string, unknown> & {
  id: string;
  source: string;
  source_id: string | null;
  title: string;
  description: string | null;
  link: string | null;
  status: string;
  subject_employee_id: string | null;
  assignee_employee_id?: string | null;
  action_kind?: string | null;
  action_params?: unknown;
  record_type?: string | null;
  record_id?: string | null;
  title_key?: string | null;
  description_key?: string | null;
  text_params?: Record<string, string | number> | null;
};

/** Joins that the page of a task needs (alias `k` is app.tasks): what it is about and where it comes from. */
export const TASK_VIEW_JOINS = `LEFT JOIN app.signature_requests sr ON k.source = 'document' AND sr.tenant_id = k.tenant_id AND sr.id = k.source_id
  LEFT JOIN app.workflow_instances wi ON k.source = 'workflow' AND wi.tenant_id = k.tenant_id AND wi.id = k.source_id
  LEFT JOIN app.workflow_templates wt ON wt.tenant_id = wi.tenant_id AND wt.id = wi.template_id
  LEFT JOIN app.automation_rules ar ON k.source = 'automation' AND ar.tenant_id = k.tenant_id AND ar.id = k.source_id
  LEFT JOIN app.approval_requests apr ON k.source = 'approval' AND apr.tenant_id = k.tenant_id AND apr.id = k.source_id
  LEFT JOIN app.approval_policies ap ON ap.tenant_id = apr.tenant_id AND ap.id = apr.policy_id
  LEFT JOIN app.asset_assignments aa ON k.record_type IN ('asset_acknowledgement', 'asset_return') AND aa.tenant_id = k.tenant_id AND aa.id = k.record_id`;
export const TASK_VIEW_COLUMNS = `sr.document_id AS href_document_id, wi.kind AS href_workflow_kind, wt.id AS workflow_template_id,
  wt.name AS workflow_name, ar.name AS automation_name, ap.name AS approval_policy, aa.asset_id AS record_asset_id`;

const text = (locale: Locale, key: string, params: Record<string, string | number> = {}) => {
  const out = t(locale, key, params);
  return out === key ? null : out;
};

/** The task's title in the reader's locale (system tasks store a catalogue key; others their own words). */
export function taskTitle(r: TaskRow, locale: Locale): string {
  return (r.title_key && text(locale, r.title_key, r.text_params ?? {})) || r.title;
}

/** The task's description in the reader's locale, or null when it has none. */
export function taskDescription(r: TaskRow, locale: Locale): string | null {
  return (r.description_key && text(locale, r.description_key, r.text_params ?? {})) || r.description;
}

/**
 * The task's action: the stored one, or for tasks made before actions existed, what their source and link
 * name (ADR-0160's `href`), so their pages still have a main button.
 */
export function taskActionOf(r: TaskRow, legacyHref: string): TaskAction | null {
  if (r.action_kind) {
    const stored = parseTaskAction({ kind: r.action_kind, params: r.action_params ?? {} });
    if (stored) return stored;
  }
  if (legacyHref === `/app/tasks/${r.id}`) return null;
  if (r.source === 'approval' && r.source_id)
    return { kind: 'open_record', params: { type: 'approval_request', id: r.source_id } };
  return {
    kind: 'open_link',
    params: { href: legacyHref, ...(r.source === 'document' ? { label: 'sign' as const } : {}) },
  };
}

export interface TaskActionView extends Omit<ResolvedTaskAction, 'labelKey'> {
  label: string;
}

export function taskActionView(r: TaskRow, legacyHref: string, locale: Locale): TaskActionView | null {
  const action = taskActionOf(r, legacyHref);
  if (!action) return null;
  const resolved = resolveTaskAction(action, { taskId: r.id, subjectEmployeeId: r.subject_employee_id });
  if (!resolved) return null;
  const { labelKey, ...rest } = resolved;
  return { ...rest, label: t(locale, labelKey) };
}

export interface TaskOriginView {
  source: string;
  label: string;
  href: string | null;
}

/** "Comes from": the real source of the task, and its page when the reader may open it. */
export function taskOrigin(
  r: TaskRow,
  principal: Principal,
  locale: Locale,
  viewerEmployeeId: string | null,
) {
  const s = (key: string, params: Record<string, string | number> = {}) =>
    t(locale, `taskActions.source.${key}`, params);
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const recordType = r.record_type ?? null;
  const subject = r.subject_employee_id;
  let label: string;
  let href: string | null = null;
  switch (r.source) {
    case 'workflow': {
      const kind = str('href_workflow_kind') ?? 'custom';
      label = s(`workflow.${['onboarding', 'offboarding', 'transfer'].includes(kind) ? kind : 'custom'}`, {
        name: str('workflow_name') ?? '',
      });
      if (canSome(principal, 'workflows.read') && str('workflow_template_id'))
        href = `/app/settings/workflows#tpl-${str('workflow_template_id')}`;
      else if (kind === 'onboarding' && subject && subject === viewerEmployeeId) href = '/app/welcome';
      break;
    }
    case 'approval':
      label = s('approval', { name: str('approval_policy') ?? '' });
      href = r.source_id ? targetHref({ type: 'approval_request', id: r.source_id }) : null;
      break;
    case 'automation':
      label = s('automation', { name: str('automation_name') ?? '' });
      if (canSome(principal, 'automation.read')) href = '/app/automation';
      break;
    case 'document': {
      label = s('document');
      const doc = str('href_document_id') ?? (recordType === 'document' ? (r.record_id ?? null) : null);
      href = doc ? targetHref({ type: 'document', id: doc }) : null;
      break;
    }
    case 'compliance': {
      label = s('compliance');
      if (canSome(principal, 'compliance.read'))
        href = recordType?.startsWith('i9_')
          ? '/app/compliance/i9'
          : recordType === 'compliance_record' || recordType === 'compliance_requirement'
            ? '/app/compliance/matrix'
            : '/app/compliance/right-to-work';
      break;
    }
    case 'asset': {
      label = s('asset');
      const asset = str('record_asset_id');
      href =
        asset && canSome(principal, 'assets.read') ? targetHref({ type: 'asset', id: asset }) : '/app/assets';
      break;
    }
    case 'absence':
      label = s('absence');
      href = subject ? personHref(subject, 'time-off') : '/app/time-off';
      break;
    case 'hr_request':
      label = s('hr_request');
      href = '/app/tasks?source=hr_request';
      break;
    default:
      label = s('manual');
  }
  return { source: r.source, label, href: safeAppLink(href) } satisfies TaskOriginView;
}

export interface TaskStatusView {
  text: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

type StatusResolver = (
  tx: Tx,
  r: TaskRow & { record_id: string },
  say: (key: string, tone: TaskStatusView['tone'], params?: Record<string, string>) => TaskStatusView,
  date: (d: string) => string,
) => Promise<TaskStatusView | null>;

const latestI9 = (tx: Tx, employeeId: string) =>
  tx.maybe<{
    section1_completed_on: string | null;
    section2_completed_on: string | null;
    section2_due_on: string | null;
    reverification_due_on: string | null;
    supplement_b_completed_on: string | null;
  }>(
    `SELECT section1_completed_on::text, section2_completed_on::text, section2_due_on::text, reverification_due_on::text, supplement_b_completed_on::text
       FROM app.i9_records WHERE employee_id = $1 ORDER BY first_day_of_employment DESC LIMIT 1`,
    [employeeId],
  );

/**
 * The live status of the record a task is linked to, per record type. Each says only what the task's own
 * title already implies (done or not, and when): never details from the vault.
 */
const STATUS: Partial<Record<TaskRecordType, StatusResolver>> = {
  approval_request: async (tx, r, say) => {
    const a = await tx.maybe<{ status: string }>('SELECT status FROM app.approval_requests WHERE id = $1', [
      r.record_id,
    ]);
    if (!a) return null;
    const tone = { pending: 'warning', approved: 'success', rejected: 'danger' } as const;
    return say(`approval.${a.status}`, tone[a.status as keyof typeof tone] ?? 'neutral');
  },
  signature_request: async (tx, r, say, date) => {
    const s = await tx.maybe<{ status: string; signed_at: string | null; approval_status: string | null }>(
      'SELECT status, signed_at::text, approval_status FROM app.signature_requests WHERE id = $1',
      [r.record_id],
    );
    if (!s) return null;
    if (s.status === 'signed' && s.approval_status === 'pending')
      return say('signature.countersign', 'warning');
    if (s.status === 'signed' && s.approval_status === 'returned')
      return say('signature.returned', 'warning');
    if (s.status === 'signed' && s.signed_at)
      return say('signature.signed', 'success', { date: date(s.signed_at.slice(0, 10)) });
    if (s.status === 'pending') return say('signature.pending', 'warning');
    return say('signature.closed', 'neutral');
  },
  asset_acknowledgement: async (tx, r, say, date) => {
    const a = await tx.maybe<{ status: string; acknowledged_on: string | null }>(
      `SELECT status, (acknowledged_at AT TIME ZONE 'UTC')::date::text AS acknowledged_on FROM app.asset_assignments WHERE id = $1`,
      [r.record_id],
    );
    if (!a) return null;
    if (a.acknowledged_on) return say('asset.acknowledged', 'success', { date: date(a.acknowledged_on) });
    if (a.status !== 'active') return say('asset.returned', 'neutral');
    return say('asset.awaitingAck', 'warning');
  },
  asset_return: async (tx, r, say, date) => {
    const a = await tx.maybe<{ status: string; returned_on: string | null; due_back_on: string | null }>(
      'SELECT status, returned_on::text, due_back_on::text FROM app.asset_assignments WHERE id = $1',
      [r.record_id],
    );
    if (!a) return null;
    if (a.status === 'returned')
      return say('asset.returnedOn', 'success', { date: date(a.returned_on ?? '') });
    if (a.status === 'lost') return say('asset.lost', 'danger', { date: date(a.returned_on ?? '') });
    return a.due_back_on
      ? say('asset.dueBack', 'warning', { date: date(a.due_back_on) })
      : say('asset.stillIssued', 'warning');
  },
  right_to_work: async (tx, r, say, date) => {
    const c = await tx.maybe<{ checked_on: string }>(
      `SELECT checked_on::text FROM app.rtw_checks WHERE employee_id = $1 AND superseded_by IS NULL ORDER BY checked_on DESC LIMIT 1`,
      [r.record_id],
    );
    return c ? say('rtw.recorded', 'success', { date: date(c.checked_on) }) : say('rtw.missing', 'warning');
  },
  rtw_check: async (tx, r, say, date) => {
    const c = await tx.maybe<{ follow_up_due_on: string | null; replaced_on: string | null }>(
      `SELECT c.follow_up_due_on::text, n.checked_on::text AS replaced_on FROM app.rtw_checks c
         LEFT JOIN app.rtw_checks n ON n.tenant_id = c.tenant_id AND n.id = c.superseded_by WHERE c.id = $1`,
      [r.record_id],
    );
    if (!c) return null;
    if (c.replaced_on) return say('rtw.replaced', 'success', { date: date(c.replaced_on) });
    return c.follow_up_due_on
      ? say('rtw.followUp', 'warning', { date: date(c.follow_up_due_on) })
      : say('rtw.current', 'neutral');
  },
  i9_section1: async (tx, r, say, date) => {
    const i = await latestI9(tx, r.record_id);
    return i?.section1_completed_on
      ? say('i9.section1Done', 'success', { date: date(i.section1_completed_on) })
      : say('i9.section1Waiting', 'warning');
  },
  i9_section2: async (tx, r, say, date) => {
    const i = await latestI9(tx, r.record_id);
    if (!i) return say('i9.noRecord', 'warning');
    if (i.section2_completed_on)
      return say('i9.section2Done', 'success', { date: date(i.section2_completed_on) });
    return i.section2_due_on
      ? say('i9.section2Due', 'warning', { date: date(i.section2_due_on) })
      : say('i9.section2Waiting', 'warning');
  },
  i9_reverify: async (tx, r, say, date) => {
    const i = await latestI9(tx, r.record_id);
    if (!i) return null;
    if (i.supplement_b_completed_on)
      return say('i9.reverified', 'success', { date: date(i.supplement_b_completed_on) });
    return i.reverification_due_on
      ? say('i9.reverifyDue', 'warning', { date: date(i.reverification_due_on) })
      : null;
  },
  compliance_record: async (tx, r, say, date) => {
    const c = await tx.maybe<{ status: string; expires_on: string | null }>(
      'SELECT status, expires_on::text FROM app.compliance_records WHERE id = $1',
      [r.record_id],
    );
    if (!c) return null;
    if (c.status !== 'active') return say('matrix.renewed', 'success');
    return c.expires_on ? say('matrix.expires', 'warning', { date: date(c.expires_on) }) : null;
  },
  compliance_requirement: async (tx, r, say, date) => {
    if (!r.subject_employee_id) return null;
    const c = await tx.maybe<{ issued_on: string }>(
      `SELECT issued_on::text FROM app.compliance_records WHERE requirement_id = $1 AND employee_id = $2 AND status = 'active' ORDER BY issued_on DESC LIMIT 1`,
      [r.record_id, r.subject_employee_id],
    );
    return c
      ? say('matrix.recorded', 'success', { date: date(c.issued_on) })
      : say('matrix.missing', 'warning');
  },
  document: async (tx, r, say, date) => {
    const d = await tx.maybe<{ expires_on: string | null; expired: boolean }>(
      'SELECT expires_on::text, expires_on < current_date AS expired FROM app.documents WHERE id = $1',
      [r.record_id],
    );
    if (!d?.expires_on) return null;
    return d.expired
      ? say('document.expired', 'danger', { date: date(d.expires_on) })
      : say('document.expires', 'warning', { date: date(d.expires_on) });
  },
  return_to_work: async (tx, r, say) => {
    const s = await tx.maybe<{ rtw_status: string }>(
      'SELECT rtw_status FROM app.sickness_records WHERE id = $1',
      [r.record_id],
    );
    if (!s) return null;
    return s.rtw_status === 'completed' ? say('absence.recorded', 'success') : say('absence.due', 'warning');
  },
};

/** The live status of the task's linked record, or null when it has none (or the record is gone). */
export async function taskRecordStatus(tx: Tx, r: TaskRow, locale: Locale): Promise<TaskStatusView | null> {
  if (!r.record_id || !isTaskRecordType(r.record_type)) return null;
  const resolver = STATUS[r.record_type];
  if (!resolver) return null;
  return resolver(
    tx,
    r as TaskRow & { record_id: string },
    (key, tone, params = {}) => ({ text: t(locale, `taskActions.status.${key}`, params), tone }),
    (d) => (d ? formatDate(d, locale) : ''),
  );
}
