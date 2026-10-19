'use client';
import * as React from 'react';
import { GitBranch, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton } from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { AssigneeFields, Checkbox, FormError, PageHeader, selectClass, SettingsCard, useAction, useRoleName, type AssigneeDraft } from '../kit';

type Op = 'present' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
interface Approver {
  type: 'manager' | 'skip_level' | 'role' | 'user';
  value?: string;
}
interface Condition {
  field: string;
  op: Op;
  value?: unknown;
}
interface Step {
  approver: Approver;
  timeoutHours?: number;
  escalateTo?: Approver;
  condition?: Condition;
}
interface Policy {
  id: string;
  subject: string;
  name: string;
  condition: Condition | null;
  priority: number;
  enabled: boolean;
  steps: Step[];
}

/** What can need approval (the subjects the API starts approvals for). */
const SUBJECTS = ['leave.request', 'employee.change', 'timesheet', 'shift.claim', 'shift.swap'];
const OPS: Op[] = ['present', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'];
const APPROVER_TYPES = ['manager', 'skip_level', 'role', 'user'];
/** Request details a condition can test, per subject (keys of the approval payload). */
const FIELDS: Record<string, string[]> = {
  'leave.request': ['leaveType', 'amountDays', 'startDate', 'endDate', 'coverWarnings'],
  'employee.change': ['jobTitle', 'payAmountMinor', 'contractType', 'noticePeriodDays', 'fte', 'weeklyHours', 'managerId', 'effectiveDate'],
  timesheet: ['workedMinutes', 'overtimeMinutes', 'violations', 'weekStart'],
  'shift.claim': ['date', 'warnings'],
  'shift.swap': ['date'],
};
const KNOWN_FIELDS = new Set(Object.values(FIELDS).flat());

interface ConditionDraft {
  on: boolean;
  field: string;
  op: Op;
  value: string;
}
interface StepDraft {
  key: number;
  approver: AssigneeDraft;
  timeout: string;
  escalate: AssigneeDraft;
  condition: ConditionDraft;
}

const scalar = (s: string): unknown => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s);
const toConditionDraft = (c?: Condition | null): ConditionDraft => ({ on: !!c, field: c?.field ?? '', op: c?.op ?? 'eq', value: c?.value === undefined ? '' : Array.isArray(c.value) ? c.value.join(', ') : String(c.value) });
function fromConditionDraft(d: ConditionDraft): Condition | undefined {
  if (!d.on || !d.field.trim()) return undefined;
  if (d.op === 'present') return { field: d.field.trim(), op: d.op };
  const value = d.op === 'in' ? d.value.split(',').map((x) => x.trim()).filter(Boolean).map(scalar) : scalar(d.value.trim());
  return { field: d.field.trim(), op: d.op, value };
}
const toAssignee = (a?: Approver): AssigneeDraft => ({ type: a?.type ?? 'manager', value: a?.value ?? '' });
const fromAssignee = (a: AssigneeDraft): Approver => ({ type: a.type as Approver['type'], ...(a.type === 'role' || a.type === 'user' ? { value: a.value } : {}) });
let nextKey = 1;
const newStep = (s?: Step): StepDraft => ({ key: nextKey++, approver: toAssignee(s?.approver), timeout: s?.timeoutHours ? String(s.timeoutHours) : '', escalate: toAssignee(s?.escalateTo ?? { type: 'role', value: 'hr_admin' }), condition: toConditionDraft(s?.condition) });

function useDescribe() {
  const t = useT();
  const roleName = useRoleName();
  const field = (k: string) => (KNOWN_FIELDS.has(k) ? t(`admin.approvals.field.${k}`) : k);
  const approver = (a: Approver) => (a.type === 'role' ? t('admin.approvals.approverText.role', { role: roleName(a.value) }) : t(`admin.approvals.approverText.${a.type}`));
  const condition = (c: Condition) =>
    c.op === 'present' ? t('admin.approvals.conditionPresent', { field: field(c.field) }) : t('admin.approvals.conditionText', { field: field(c.field), op: t(`admin.approvals.op.${c.op}`), value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '') });
  return { field, approver, condition };
}

function ConditionFields({ id, subject, legend, value, onChange }: { id: string; subject: string; legend: string; value: ConditionDraft; onChange: (v: ConditionDraft) => void }) {
  const t = useT();
  const describe = useDescribe();
  return (
    <div className="flex flex-col gap-3">
      <Checkbox id={`${id}-on`} label={legend} checked={value.on} onChange={(on) => onChange({ ...value, on })} />
      {value.on ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id={`${id}-field`} label={t('admin.approvals.conditionField')} hint={t('admin.approvals.conditionFieldHint')}>
            {(p) => (
              <>
                <Input {...p} required list={`${id}-fields`} spellCheck={false} value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })} />
                <datalist id={`${id}-fields`}>
                  {(FIELDS[subject] ?? []).map((f) => (
                    <option key={f} value={f}>
                      {describe.field(f)}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field id={`${id}-op`} label={t('admin.approvals.conditionOp')}>
            {(p) => (
              <select {...p} className={selectClass} value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as Op })}>
                {OPS.map((o) => (
                  <option key={o} value={o}>
                    {t(`admin.approvals.op.${o}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {value.op !== 'present' ? (
            <Field id={`${id}-value`} label={t('admin.approvals.conditionValue')} hint={value.op === 'in' ? t('admin.approvals.conditionInHint') : undefined}>
              {(p) => <Input {...p} required value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />}
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChainEditor({ policy, onDone }: { policy: Policy | null; onDone: (saved: boolean) => void }) {
  const t = useT();
  const action = useAction();
  const heading = React.useRef<HTMLHeadingElement>(null);
  const [name, setName] = React.useState(policy?.name ?? '');
  const [subject, setSubject] = React.useState(policy?.subject ?? 'leave.request');
  const [priority, setPriority] = React.useState(String(policy?.priority ?? 100));
  const [enabled, setEnabled] = React.useState(policy?.enabled ?? true);
  const [condition, setCondition] = React.useState(toConditionDraft(policy?.condition));
  const [steps, setSteps] = React.useState<StepDraft[]>(() => (policy?.steps.length ? policy.steps.map(newStep) : [newStep()]));
  React.useEffect(() => heading.current?.focus(), []);
  const setStep = (key: number, patch: Partial<StepDraft>) => setSteps((xs) => xs.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (steps.some((s) => (['role', 'user'].includes(s.approver.type) && !s.approver.value) || (s.timeout && ['role', 'user'].includes(s.escalate.type) && !s.escalate.value))) {
      action.setError(t('admin.approvals.needsApprover'));
      return;
    }
    const body = {
      subject,
      name: name.trim(),
      priority: Number(priority),
      condition: fromConditionDraft(condition) ?? null,
      steps: steps.map((s) => {
        const c = fromConditionDraft(s.condition);
        return { approver: fromAssignee(s.approver), ...(s.timeout ? { timeoutHours: Number(s.timeout), escalateTo: fromAssignee(s.escalate) } : {}), ...(c ? { condition: c } : {}) };
      }),
      ...(policy ? { enabled } : {}),
    };
    const ok = await action.run(() => (policy ? api(`/v1/approval-policies/${policy.id}`, { method: 'PUT', json: body }) : api('/v1/approval-policies', { method: 'POST', json: body })), t('admin.approvals.saved'));
    if (ok) onDone(true);
  }

  return (
    <section aria-labelledby="chain-editor-title" className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
      <h2 id="chain-editor-title" ref={heading} tabIndex={-1} className="text-title-3 outline-none">
        {policy ? t('admin.approvals.editTitle', { name: policy.name }) : t('admin.approvals.newTitle')}
      </h2>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="chain-name" label={t('admin.name')}>
            {(p) => <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field id="chain-subject" label={t('admin.approvals.subject')}>
            {(p) => (
              <select {...p} className={selectClass} value={subject} onChange={(e) => setSubject(e.target.value)}>
                {!SUBJECTS.includes(subject) ? <option value={subject}>{subject}</option> : null}
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`admin.approvals.subjects.${s}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="chain-priority" label={t('admin.approvals.priority')} hint={t('admin.approvals.priorityHint')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" required step={1} value={priority} onChange={(e) => setPriority(e.target.value)} />}
          </Field>
        </div>
        <ConditionFields id="chain-condition" subject={subject} legend={t('admin.approvals.chainCondition')} value={condition} onChange={setCondition} />
        {policy ? <Checkbox id="chain-enabled" label={t('admin.approvals.enabled')} hint={t('admin.approvals.enabledHint')} checked={enabled} onChange={setEnabled} /> : null}
        <ol className="flex flex-col gap-4">
          {steps.map((s, i) => (
            <li key={s.key} className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <h3 className="mr-auto text-callout font-semibold">{t('admin.approvals.stepN', { n: i + 1 })}</h3>
                {steps.length > 1 ? (
                  <Button type="button" size="sm" variant="ghost" aria-label={t('admin.approvals.removeStep', { n: i + 1 })} onClick={() => setSteps((xs) => xs.filter((x) => x.key !== s.key))}>
                    <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('admin.remove')}
                  </Button>
                ) : null}
              </div>
              <AssigneeFields id={`step-${s.key}-approver`} legend={t('admin.approvals.approver')} types={APPROVER_TYPES} labelKey="admin.approvals.approverType" value={s.approver} onChange={(approver) => setStep(s.key, { approver })} />
              <Field id={`step-${s.key}-timeout`} label={t('admin.approvals.timeout')} hint={t('admin.approvals.timeoutHint')}>
                {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={720} step={1} className="sm:w-40" value={s.timeout} onChange={(e) => setStep(s.key, { timeout: e.target.value })} />}
              </Field>
              {s.timeout ? <AssigneeFields id={`step-${s.key}-escalate`} legend={t('admin.approvals.escalateTo')} types={APPROVER_TYPES} labelKey="admin.approvals.approverType" value={s.escalate} onChange={(escalate) => setStep(s.key, { escalate })} /> : null}
              <ConditionFields id={`step-${s.key}-condition`} subject={subject} legend={t('admin.approvals.stepCondition')} value={s.condition} onChange={(condition) => setStep(s.key, { condition })} />
            </li>
          ))}
        </ol>
        {steps.length < 10 ? (
          <Button type="button" variant="secondary" className="self-start" onClick={() => setSteps((xs) => [...xs, newStep()])}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.approvals.addStep')}
          </Button>
        ) : null}
        <FormError message={action.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={action.busy}>
            {t('common.save')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => onDone(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function PolicyItem({ p, onEdit }: { p: Policy; onEdit: () => void }) {
  const t = useT();
  const locale = useLocale();
  const describe = useDescribe();
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="mr-auto text-callout font-semibold">{p.name}</h4>
        {p.enabled ? <Badge tone="success">{t('admin.on')}</Badge> : <Badge>{t('admin.off')}</Badge>}
        <Badge>{t('admin.approvals.priorityN', { n: p.priority })}</Badge>
        <Button size="sm" variant="ghost" aria-label={t('admin.editLabel', { name: p.name })} onClick={onEdit}>
          <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('common.edit')}
        </Button>
      </div>
      <p className="text-footnote text-text-secondary">{p.condition ? t('admin.approvals.appliesWhen', { condition: describe.condition(p.condition) }) : t('admin.approvals.appliesAlways')}</p>
      <ol className="flex flex-col gap-1 text-callout">
        {p.steps.map((s, i) => (
          <li key={i}>
            <span className="font-semibold">{t('admin.approvals.stepN', { n: i + 1 })}:</span> {describe.approver(s.approver)}
            {s.timeoutHours ? <span className="text-text-secondary"> · {t('admin.approvals.escalates', { amount: formatUnit(s.timeoutHours, 'hour', locale), to: s.escalateTo ? describe.approver(s.escalateTo) : t('roles.hr_admin') })}</span> : null}
            {s.condition ? <span className="text-text-secondary"> · {t('admin.approvals.onlyWhen', { condition: describe.condition(s.condition) })}</span> : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

/** Approval chains: which requests need approval, by whom, in which order, with escalation. */
export default function ApprovalChainsPage() {
  const t = useT();
  const policies = useApi<Policy[]>('/v1/approval-policies');
  const [editing, setEditing] = React.useState<Policy | 'new' | null>(null);
  const done = (saved: boolean) => {
    setEditing(null);
    if (saved) policies.reload();
  };
  const bySubject = SUBJECTS.map((s) => ({ subject: s, items: (policies.data ?? []).filter((p) => p.subject === s) })).filter((g) => g.items.length);
  const other = (policies.data ?? []).filter((p) => !SUBJECTS.includes(p.subject));

  return (
    <>
      <PageHeader title={t('admin.section.approvalChains.title')} lead={t('admin.approvals.lead')}>
        {editing ? null : (
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.approvals.new')}
          </Button>
        )}
      </PageHeader>
      {editing ? <ChainEditor key={editing === 'new' ? 'new' : editing.id} policy={editing === 'new' ? null : editing} onDone={done} /> : null}
      {policies.error ? <FormError message={policies.error.title} /> : null}
      {!policies.data && !policies.error ? (
        <Skeleton className="h-40" />
      ) : policies.data && policies.data.length === 0 ? (
        <EmptyState icon={<GitBranch aria-hidden />} title={t('admin.approvals.none')} body={t('admin.approvals.noneBody')} />
      ) : (
        <>
          {bySubject.map((g) => (
            <SettingsCard key={g.subject} id={`chains-${g.subject.replace('.', '-')}`} title={t(`admin.approvals.subjects.${g.subject}`)} description={t('admin.approvals.orderHint')}>
              <ul className="flex flex-col gap-3">
                {g.items.map((p) => (
                  <PolicyItem key={p.id} p={p} onEdit={() => setEditing(p)} />
                ))}
              </ul>
            </SettingsCard>
          ))}
          {other.length ? (
            <SettingsCard id="chains-other" title={t('admin.approvals.otherSubjects')}>
              <ul className="flex flex-col gap-3">
                {other.map((p) => (
                  <PolicyItem key={p.id} p={p} onEdit={() => setEditing(p)} />
                ))}
              </ul>
            </SettingsCard>
          ) : null}
        </>
      )}
    </>
  );
}
