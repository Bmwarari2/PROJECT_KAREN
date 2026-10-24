import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUES, flatten } from '../src/i18n/catalogues';
import { PROFILE_TABS, TARGET_TYPES } from '../src/links';
import {
  closesItself,
  dueRuleOf,
  FORM_KINDS,
  OPEN_LINK_LABELS,
  parseDueRule,
  parseTaskAction,
  PICKABLE_TASK_ACTION_KINDS,
  RECORD_TYPES_CLOSED_TODAY,
  resolveTaskAction,
  TASK_ACTION_KINDS,
  TASK_RECORD_TYPES,
  taskActionContractHref,
  taskActionKind,
  taskActionKindLabel,
  taskActionRecord,
  type TaskAction,
} from '../src/task-actions';

/**
 * The task action registry (ADR-0191): every kind has a button label in both catalogues, builds its page
 * with the person already chosen, never leads to a missing page (a placeholder opens its fallback), and
 * names the record that closes its tasks. Fictional ids only.
 */
const TASK = '11111111-2222-4333-8444-555555555555';
const PERSON = '7d6f1c2a-3b4e-4c5d-8e9f-0a1b2c3d4e5f';
const TEMPLATE = '0b7a1d4e-9c2f-4e8a-9b1d-3c5e7f9a1b2c';
const ctx = { taskId: TASK, subjectEmployeeId: PERSON };

/** One valid action of every kind (and every variant of the generic ones). */
const SAMPLES: TaskAction[] = [
  ...OPEN_LINK_LABELS.map((label) => ({
    kind: 'open_link' as const,
    params: { href: '/app/payroll', label },
  })),
  { kind: 'open_person', params: {} },
  ...PROFILE_TABS.map((tab) => ({ kind: 'open_person' as const, params: { tab } })),
  ...TARGET_TYPES.map((type) => ({ kind: 'open_record' as const, params: { type, id: PERSON } })),
  { kind: 'send_document', params: { templateId: TEMPLATE } },
  { kind: 'send_document', params: {} },
  { kind: 'rtw_check', params: {} },
  { kind: 'i9_section1', params: {} },
  { kind: 'i9_section2', params: {} },
  { kind: 'i9_reverify', params: {} },
  { kind: 'compliance_renewal', params: { requirementId: TEMPLATE } },
  { kind: 'payroll_starter', params: {} },
  { kind: 'payroll_leaver', params: {} },
  ...FORM_KINDS.map((formKind) => ({ kind: 'form' as const, params: { formKind } })),
  { kind: 'it_request', params: {} },
  { kind: 'access_removal', params: {} },
];

describe('the task action registry', () => {
  it('defines every kind, and the samples cover them all', () => {
    for (const kind of TASK_ACTION_KINDS) expect(taskActionKind(kind).kind).toBe(kind);
    expect(new Set(SAMPLES.map((a) => a.kind))).toEqual(new Set(TASK_ACTION_KINDS));
  });

  it('labels every button and names every kind in both catalogues', () => {
    for (const locale of ['en-GB', 'en-US'] as const) {
      const keys = new Set(Object.keys(flatten(CATALOGUES[locale])));
      for (const a of SAMPLES) {
        const def = taskActionKind(a.kind);
        expect(keys.has(def.label(a.params as never)), `${locale} ${JSON.stringify(a)}`).toBe(true);
      }
      for (const kind of TASK_ACTION_KINDS) expect(keys.has(taskActionKindLabel(kind)), kind).toBe(true);
    }
  });

  it('opens the work with the person already chosen, and every placeholder falls back to a page that exists', () => {
    for (const a of SAMPLES) {
      const r = resolveTaskAction(a, ctx);
      expect(r, JSON.stringify(a)).not.toBeNull();
      expect(r!.href, JSON.stringify(a)).toMatch(/^\/app(\/|\?|#|$)/);
      expect(r!.kind).toBe(a.kind);
      // a placeholder opens a generic kind that has landed, with that kind's (truthful) label
      expect(taskActionKind(r!.opens).landed).toBe(true);
      expect(r!.landed).toBe(taskActionKind(a.kind).landed);
    }
    expect(resolveTaskAction({ kind: 'open_person', params: { tab: 'compliance' } }, ctx)).toEqual({
      kind: 'open_person',
      opens: 'open_person',
      labelKey: 'taskActions.button.person.compliance',
      href: `/app/people/${PERSON}?tab=compliance`,
      landed: true,
    });
    // until part C lands, "Prepare and send" opens the person's documents, labelled as such
    expect(resolveTaskAction({ kind: 'send_document', params: { templateId: TEMPLATE } }, ctx)).toEqual({
      kind: 'send_document',
      opens: 'open_person',
      labelKey: 'taskActions.button.person.documents',
      href: `/app/people/${PERSON}?tab=documents`,
      landed: false,
    });
  });

  it('publishes the contract hrefs the owning parts build', () => {
    const href = (a: TaskAction) => taskActionContractHref(a, ctx);
    expect(href({ kind: 'send_document', params: { templateId: TEMPLATE } })).toBe(
      `/app/people/${PERSON}/documents/new?template=${TEMPLATE}&task=${TASK}`,
    );
    expect(href({ kind: 'send_document', params: {} })).toBe(
      `/app/people/${PERSON}/documents/new?task=${TASK}`,
    );
    expect(href({ kind: 'rtw_check', params: {} })).toBe(
      `/app/compliance/right-to-work?record=${PERSON}&task=${TASK}`,
    );
    expect(href({ kind: 'i9_section1', params: {} })).toBe(`/app/me/i9?task=${TASK}`);
    expect(href({ kind: 'i9_section2', params: {} })).toBe(
      `/app/compliance/i9?record=${PERSON}&section=2&task=${TASK}`,
    );
    expect(href({ kind: 'i9_reverify', params: {} })).toBe(
      `/app/compliance/i9?record=${PERSON}&reverify=1&task=${TASK}`,
    );
    expect(href({ kind: 'compliance_renewal', params: { requirementId: TEMPLATE } })).toBe(
      `/app/compliance/matrix?record=${PERSON}&requirement=${TEMPLATE}&task=${TASK}`,
    );
    expect(href({ kind: 'payroll_starter', params: {} })).toBe(
      `/app/payroll/starters/${PERSON}?task=${TASK}`,
    );
    expect(href({ kind: 'payroll_leaver', params: {} })).toBe(`/app/payroll/leavers/${PERSON}?task=${TASK}`);
    expect(href({ kind: 'form', params: { formKind: 'exit_interview' } })).toBe(
      `/app/forms/exit_interview/new?employee=${PERSON}&task=${TASK}`,
    );
    expect(href({ kind: 'it_request', params: {} })).toBe(
      `/app/it/requests/new?employee=${PERSON}&task=${TASK}`,
    );
    expect(href({ kind: 'access_removal', params: {} })).toBe(`/app/people/${PERSON}/access?task=${TASK}`);
  });

  it('has no button for a person-scoped kind when the task is about nobody', () => {
    const nobody = { taskId: TASK, subjectEmployeeId: null };
    expect(resolveTaskAction({ kind: 'open_person', params: {} }, nobody)).toBeNull();
    expect(resolveTaskAction({ kind: 'send_document', params: {} }, nobody)).toBeNull();
    expect(resolveTaskAction({ kind: 'open_link', params: { href: '/app/payroll' } }, nobody)).not.toBeNull();
  });

  it('names the record that closes each kind’s tasks', () => {
    const rec = (a: TaskAction) => taskActionRecord(a, ctx);
    expect(rec({ kind: 'rtw_check', params: {} })).toEqual({ type: 'right_to_work', id: PERSON });
    expect(rec({ kind: 'i9_section2', params: {} })).toEqual({ type: 'i9_section2', id: PERSON });
    expect(rec({ kind: 'send_document', params: { templateId: TEMPLATE } })).toEqual({
      type: 'document_send',
      id: TEMPLATE,
    });
    expect(rec({ kind: 'send_document', params: {} })).toBeNull();
    expect(rec({ kind: 'form', params: { formKind: 'probation_review' } })).toEqual({
      type: 'form.probation_review',
      id: PERSON,
    });
    expect(rec({ kind: 'open_record', params: { type: 'asset_return', id: TEMPLATE } })).toEqual({
      type: 'asset_return',
      id: TEMPLATE,
    });
    expect(rec({ kind: 'open_record', params: { type: 'asset_assignment', id: TEMPLATE } })).toEqual({
      type: 'asset_acknowledgement',
      id: TEMPLATE,
    });
    expect(rec({ kind: 'open_record', params: { type: 'payslip', id: TEMPLATE } })).toBeNull();
    expect(rec({ kind: 'open_person', params: {} })).toBeNull();
    for (const a of SAMPLES) {
      const r = rec(a);
      if (r) expect(TASK_RECORD_TYPES).toContain(r.type);
    }
  });

  it('refuses actions it cannot trust', () => {
    expect(parseTaskAction({ kind: 'open_link', params: { href: 'https://evil.example/app' } })).toBeNull();
    expect(parseTaskAction({ kind: 'open_link', params: { href: '//evil.example/app' } })).toBeNull();
    expect(parseTaskAction({ kind: 'open_link', params: { href: '/app/x', label: 'free text' } })).toBeNull();
    expect(parseTaskAction({ kind: 'open_record', params: { type: 'employee', id: '../x' } })).toBeNull();
    expect(parseTaskAction({ kind: 'open_record', params: { type: 'nope', id: PERSON } })).toBeNull();
    expect(parseTaskAction({ kind: 'open_person', params: { tab: 'pay' } })).toBeNull();
    expect(parseTaskAction({ kind: 'form', params: {} })).toBeNull();
    expect(parseTaskAction({ kind: 'form', params: { formKind: 'anything' } })).toBeNull();
    expect(parseTaskAction({ kind: 'send_document', params: { templateId: 'x' } })).toBeNull();
    expect(parseTaskAction({ kind: 'nope', params: {} })).toBeNull();
    expect(parseTaskAction('open_link')).toBeNull();
    // normalised: ids lower-cased, empty optional ids dropped
    expect(parseTaskAction({ kind: 'send_document', params: { templateId: '' } })).toEqual({
      kind: 'send_document',
      params: {},
    });
    expect(parseTaskAction({ kind: 'rtw_check' })).toEqual({ kind: 'rtw_check', params: {} });
  });

  it('offers the kinds a template can use in the editor (not records, which a template does not have)', () => {
    expect(PICKABLE_TASK_ACTION_KINDS).not.toContain('open_record');
    expect(PICKABLE_TASK_ACTION_KINDS).toContain('send_document');
    expect(PICKABLE_TASK_ACTION_KINDS).toContain('i9_section2');
  });
});

describe('due rules', () => {
  it('keeps dueOffsetDays working and validates the new model', () => {
    expect(dueRuleOf({ dueOffsetDays: -3 })).toEqual({ anchor: 'anchor', offsetDays: -3 });
    expect(dueRuleOf({ dueOffsetDays: 3, due: { anchor: 'probation_end', offsetDays: -7 } })).toEqual({
      anchor: 'probation_end',
      offsetDays: -7,
    });
    // an invalid rule falls back to dueOffsetDays
    expect(dueRuleOf({ dueOffsetDays: 2, due: { anchor: 'nope', offsetDays: 1 } })).toEqual({
      anchor: 'anchor',
      offsetDays: 2,
    });
    expect(parseDueRule({ anchor: 'start', offsetDays: 3, businessDays: true })).toEqual({
      anchor: 'start',
      offsetDays: 3,
      businessDays: true,
    });
    expect(parseDueRule({ anchor: 'start', offsetDays: 0, packDeadline: 'i9_section2' })).toEqual({
      anchor: 'start',
      offsetDays: 0,
      packDeadline: 'i9_section2',
    });
    expect(parseDueRule({ anchor: 'start', offsetDays: 1.5 })).toBeNull();
    expect(parseDueRule({ anchor: 'start', offsetDays: 400 })).toBeNull();
    expect(parseDueRule({ anchor: 'start', offsetDays: 1, packDeadline: 'made_up' })).toBeNull();
  });
});

describe('tasks that close themselves', () => {
  const root = join(__dirname, '..', '..', '..');
  const api = execFileSync('git', ['ls-files', 'apps/api/src'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(root, f), 'utf8'))
    .join('\n');

  it('only promises "closes by itself" for record types an owning module closes', () => {
    for (const type of RECORD_TYPES_CLOSED_TODAY) {
      expect(closesItself(type)).toBe(true);
      // a completeTasksFor call names it (directly, or through the I-9 helper's list)
      expect(
        api.includes(`recordType: '${type}'`) || api.includes(`['${type}'] as const`),
        `no completeTasksFor call closes ${type}`,
      ).toBe(true);
    }
    expect(closesItself('document_send')).toBe(false);
    expect(closesItself('form.exit_interview')).toBe(false);
    expect(closesItself('nope')).toBe(false);
  });
});
