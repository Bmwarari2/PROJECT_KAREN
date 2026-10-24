'use client';
import * as React from 'react';
import { Field, Input } from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { PROFILE_TABS, safeAppLink, type ProfileTab } from '@thapsus/core/links';
import {
  FORM_KINDS,
  parseTaskAction,
  PICKABLE_TASK_ACTION_KINDS,
  taskActionKindLabel,
  type DueRule,
  type FormKind,
  type TaskAction,
  type TaskActionKind,
} from '@thapsus/core/task-actions';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { Checkbox, selectClass, usePermission } from '../kit';

/**
 * The workflow editor's action picker and due-date fields (ADR-0191, ADR-0193). Drafts hold what the
 * form shows; `draftToAction` and `draftToDue` turn them into a template task's `action`, `due` and
 * `dueOffsetDays` (a calendar count from the workflow's date stays a plain `dueOffsetDays`, as before).
 */
export type WorkflowKind = 'onboarding' | 'offboarding' | 'transfer' | 'custom';

export interface ActionDraft {
  kind: '' | TaskActionKind;
  href: string;
  tab: '' | ProfileTab;
  templateId: string;
  formKind: '' | FormKind;
}
export const emptyAction = (): ActionDraft => ({ kind: '', href: '', tab: '', templateId: '', formKind: '' });

export function actionToDraft(a: unknown): ActionDraft {
  const action = a ? parseTaskAction(a) : null;
  if (!action) return emptyAction();
  const p = action.params as Record<string, string | undefined>;
  return {
    ...emptyAction(),
    kind: action.kind,
    href: p.href ?? '',
    tab: (p.tab as ProfileTab | undefined) ?? '',
    templateId: p.templateId ?? '',
    formKind: (p.formKind as FormKind | undefined) ?? '',
  };
}

/** The template task's action, `undefined` for none, or `null` when the draft is incomplete. */
export function draftToAction(d: ActionDraft): TaskAction | undefined | null {
  if (!d.kind) return undefined;
  const params =
    d.kind === 'open_link'
      ? { href: d.href.trim() }
      : d.kind === 'open_person'
        ? d.tab
          ? { tab: d.tab }
          : {}
        : d.kind === 'send_document'
          ? d.templateId
            ? { templateId: d.templateId }
            : {}
          : d.kind === 'form'
            ? { formKind: d.formKind }
            : {};
  return parseTaskAction({ kind: d.kind, params });
}

export type DueFrom = 'anchor' | 'start' | 'end' | 'probation_end' | 'i9_section2';
export interface DueDraft {
  from: DueFrom;
  offset: string;
  business: boolean;
}
export const emptyDue = (): DueDraft => ({ from: 'anchor', offset: '0', business: false });

export function dueToDraft(t: { dueOffsetDays: number; due?: DueRule }): DueDraft {
  if (!t.due) return { from: 'anchor', offset: String(t.dueOffsetDays), business: false };
  if (t.due.packDeadline) return { from: t.due.packDeadline, offset: '0', business: false };
  return { from: t.due.anchor, offset: String(t.due.offsetDays), business: !!t.due.businessDays };
}

export function draftToDue(d: DueDraft): { dueOffsetDays: number; due?: DueRule } {
  const offset = Number(d.offset) || 0;
  if (d.from === 'i9_section2')
    return { dueOffsetDays: 0, due: { anchor: 'start', offsetDays: 0, packDeadline: 'i9_section2' } };
  if (d.from === 'anchor' && !d.business) return { dueOffsetDays: offset };
  return {
    dueOffsetDays: offset,
    due: { anchor: d.from, offsetDays: offset, ...(d.business ? { businessDays: true } : {}) },
  };
}

const FROM: DueFrom[] = ['anchor', 'start', 'end', 'probation_end', 'i9_section2'];

/** "What the task opens" and the details its kind needs. */
export function ActionFields({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ActionDraft;
  onChange: (v: ActionDraft) => void;
}) {
  const t = useT();
  const has = usePermission();
  const templates = useApi<Array<{ id: string; name: string }>>(
    value.kind === 'send_document' && has('documents.manage') ? '/v1/document-templates' : null,
  );
  const set = (patch: Partial<ActionDraft>) => onChange({ ...value, ...patch });
  const linkInvalid = value.kind === 'open_link' && !!value.href.trim() && !safeAppLink(value.href.trim());
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id={`${id}-action`}
        label={t('taskActions.editor.action')}
        hint={t('taskActions.editor.actionHint')}
      >
        {(p) => (
          <select
            {...p}
            className={selectClass}
            value={value.kind}
            onChange={(e) => set({ kind: e.target.value as ActionDraft['kind'] })}
          >
            <option value="">{t('taskActions.editor.none')}</option>
            {PICKABLE_TASK_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(taskActionKindLabel(k))}
              </option>
            ))}
          </select>
        )}
      </Field>
      {value.kind === 'open_link' ? (
        <Field
          id={`${id}-href`}
          label={t('taskActions.editor.link')}
          hint={t('taskActions.editor.linkHint')}
          error={linkInvalid ? t('taskActions.editor.linkInvalid') : undefined}
        >
          {(p) => (
            <Input
              {...p}
              required
              maxLength={500}
              inputMode="url"
              value={value.href}
              onChange={(e) => set({ href: e.target.value })}
            />
          )}
        </Field>
      ) : value.kind === 'open_person' ? (
        <Field id={`${id}-tab`} label={t('taskActions.editor.tab')}>
          {(p) => (
            <select
              {...p}
              className={selectClass}
              value={value.tab || 'overview'}
              onChange={(e) => set({ tab: e.target.value as ProfileTab })}
            >
              {PROFILE_TABS.map((tab) => (
                <option key={tab} value={tab}>
                  {t(`taskActions.editor.tabs.${tab}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : value.kind === 'send_document' ? (
        <Field id={`${id}-template`} label={t('taskActions.editor.template')}>
          {(p) => (
            <select
              {...p}
              className={selectClass}
              value={value.templateId}
              onChange={(e) => set({ templateId: e.target.value })}
            >
              <option value="">{t('taskActions.editor.anyTemplate')}</option>
              {(templates.data ?? []).map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : value.kind === 'form' ? (
        <Field id={`${id}-form`} label={t('taskActions.editor.formKind')}>
          {(p) => (
            <select
              {...p}
              required
              className={selectClass}
              value={value.formKind}
              onChange={(e) => set({ formKind: e.target.value as FormKind })}
            >
              <option value="" disabled>
                {t('taskActions.editor.formKind')}
              </option>
              {FORM_KINDS.map((f) => (
                <option key={f} value={f}>
                  {t(`taskActions.editor.form.${f}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
    </div>
  );
}

/** When the task is due: from the workflow's date or the person's own dates, in calendar or business days. */
export function DueFields({
  id,
  kind,
  value,
  onChange,
}: {
  id: string;
  kind: WorkflowKind;
  value: DueDraft;
  onChange: (v: DueDraft) => void;
}) {
  const t = useT();
  const set = (patch: Partial<DueDraft>) => onChange({ ...value, ...patch });
  const workflowAnchor = t(`admin.workflows.anchor.${kind}`);
  const offsetLabel =
    value.from === 'anchor'
      ? value.business
        ? t('taskActions.editor.offsetFromWorkflowBusiness', { anchor: workflowAnchor })
        : t('admin.workflows.dueOffset', { anchor: workflowAnchor })
      : t(value.business ? 'taskActions.editor.offsetFromBusiness' : 'taskActions.editor.offsetFrom', {
          anchor: t(`taskActions.editor.anchorText.${value.from}`),
        });
  return (
    <>
      <Field
        id={`${id}-from`}
        label={t('taskActions.editor.dueFrom')}
        hint={t('taskActions.editor.dueFromHint')}
      >
        {(p) => (
          <select
            {...p}
            className={selectClass}
            value={value.from}
            onChange={(e) => set({ from: e.target.value as DueFrom })}
          >
            {FROM.map((f) => (
              <option key={f} value={f}>
                {t(`taskActions.editor.from.${f}`, { anchor: workflowAnchor })}
              </option>
            ))}
          </select>
        )}
      </Field>
      {value.from !== 'i9_section2' ? (
        <>
          <Field id={`${id}-due`} label={offsetLabel} hint={t('admin.workflows.dueOffsetHint')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                required
                min={-365}
                max={365}
                step={1}
                value={value.offset}
                onChange={(e) => set({ offset: e.target.value })}
              />
            )}
          </Field>
          <Checkbox
            id={`${id}-business`}
            label={t('taskActions.editor.businessDays')}
            hint={t('taskActions.editor.businessDaysHint')}
            checked={value.business}
            onChange={(business) => set({ business })}
          />
        </>
      ) : null}
    </>
  );
}

/** How a template task's due date reads in the template's table. */
export function useDueText() {
  const t = useT();
  const locale = useLocale();
  return (kind: WorkflowKind, task: { dueOffsetDays: number; due?: DueRule }) => {
    const rule = task.due;
    if (rule?.packDeadline) return t(`taskActions.editor.packDeadline.${rule.packDeadline}`);
    const days = rule ? rule.offsetDays : task.dueOffsetDays;
    const amount = rule?.businessDays
      ? t('taskActions.editor.businessDayCount', { count: Math.abs(days) })
      : formatUnit(Math.abs(days), 'day', locale);
    if (!rule || rule.anchor === 'anchor') {
      const anchor = t(`admin.workflows.anchor.${kind}`);
      if (days === 0) return t('admin.workflows.dueOn', { anchor });
      return t(days < 0 ? 'admin.workflows.dueBefore' : 'admin.workflows.dueAfter', { amount, anchor });
    }
    const anchor = t(`taskActions.editor.anchorText.${rule.anchor}`);
    if (days === 0) return t('taskActions.editor.dueText.on', { anchor });
    return t(days < 0 ? 'taskActions.editor.dueText.before' : 'taskActions.editor.dueText.after', {
      amount,
      anchor,
    });
  };
}
