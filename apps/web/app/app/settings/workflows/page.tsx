'use client';
import * as React from 'react';
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { taskActionKindLabel, type DueRule, type TaskAction } from '@thapsus/core/task-actions';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  AssigneeFields,
  Checkbox,
  FormError,
  PageHeader,
  selectClass,
  SettingsCard,
  useAction,
  useOrg,
  usePermission,
  useRoleName,
  type AssigneeDraft,
} from '../kit';
import { useSectionLevel } from '@/components/module-page';
import {
  actionToDraft,
  ActionFields,
  draftToAction,
  draftToDue,
  DueFields,
  dueToDraft,
  emptyAction,
  emptyDue,
  useDueText,
  type ActionDraft,
  type DueDraft,
} from './task-fields';

type Kind = 'onboarding' | 'offboarding' | 'transfer' | 'custom';
interface TaskDef {
  key: string;
  title: string;
  description?: string;
  assignee: { type: 'role' | 'manager' | 'employee' | 'user'; value?: string };
  dueOffsetDays: number;
  /** When it is due, when it does not simply count days from the workflow's date (ADR-0193). */
  due?: DueRule;
  reminderDaysBefore?: number;
  /** The main button of the tasks it creates (ADR-0191). */
  action?: TaskAction;
}
interface Template {
  id: string;
  kind: Kind;
  name: string;
  tasks: TaskDef[];
  autoStart: boolean;
  entityId: string | null;
}

const KINDS: Kind[] = ['onboarding', 'offboarding', 'transfer', 'custom'];
const ASSIGNEE_TYPES = ['manager', 'employee', 'role', 'user'];

interface TaskDraft {
  key: number;
  /** The template task's own key, kept when a template is edited. */
  taskKey?: string;
  title: string;
  description: string;
  assignee: AssigneeDraft;
  due: DueDraft;
  reminder: string;
  action: ActionDraft;
}
// Row keys (and the field ids built from them) come from a counter per form, not from module state:
// a module counter keeps counting across server renders, so the server's ids would not match the client's
// and React keeps the server's id attributes on hydration, which gave two rows the same id.
const newTask = (key: number): TaskDraft => ({
  key,
  title: '',
  description: '',
  assignee: { type: 'manager', value: '' },
  due: emptyDue(),
  reminder: '',
  action: emptyAction(),
});
const draftOf = (key: number, x: TaskDef): TaskDraft => ({
  key,
  taskKey: x.key,
  title: x.title,
  description: x.description ?? '',
  assignee: { type: x.assignee.type, value: x.assignee.value ?? '' },
  due: dueToDraft(x),
  reminder: x.reminderDaysBefore === undefined ? '' : String(x.reminderDaysBefore),
  action: actionToDraft(x.action),
});

/** Creates a template, or edits one (`template`): edits apply to workflows started from then on. */
function TemplateEditor({ template, onDone }: { template?: Template; onDone: (saved: boolean) => void }) {
  const t = useT();
  const sec = useSectionLevel();
  const action = useAction();
  const entities = useOrg('legal-entities');
  const heading = React.useRef<HTMLHeadingElement>(null);
  const [kind, setKind] = React.useState<Kind>(template?.kind ?? 'onboarding');
  const [name, setName] = React.useState(template?.name ?? '');
  const [entityId, setEntityId] = React.useState(template?.entityId ?? '');
  const [autoStart, setAutoStart] = React.useState(template?.autoStart ?? true);
  const nextKey = React.useRef(template?.tasks.length ?? 1);
  const [tasks, setTasks] = React.useState<TaskDraft[]>(() =>
    template ? template.tasks.map((x, i) => draftOf(i, x)) : [newTask(0)],
  );
  const headingId = template ? `template-editor-${template.id}-title` : 'template-editor-title';
  React.useEffect(() => heading.current?.focus(), []);
  const setTask = (key: number, patch: Partial<TaskDraft>) =>
    setTasks((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (tasks.some((x) => ['role', 'user'].includes(x.assignee.type) && !x.assignee.value)) {
      action.setError(t('admin.workflows.needsAssignee'));
      return;
    }
    if (tasks.some((x) => draftToAction(x.action) === null)) {
      action.setError(t('taskActions.editor.linkInvalid'));
      return;
    }
    const used = new Set(tasks.map((x) => x.taskKey).filter(Boolean));
    let n = 0;
    const freshKey = () => {
      do n++;
      while (used.has(`task-${n}`));
      return `task-${n}`;
    };
    const taskBodies = tasks.map((x) => {
      const taskAction = draftToAction(x.action);
      return {
        key: x.taskKey ?? freshKey(),
        title: x.title.trim(),
        ...(x.description.trim() ? { description: x.description.trim() } : {}),
        assignee: {
          type: x.assignee.type,
          ...(x.assignee.type === 'role' || x.assignee.type === 'user' ? { value: x.assignee.value } : {}),
        },
        ...draftToDue(x.due),
        ...(x.reminder.trim() ? { reminderDaysBefore: Number(x.reminder) } : {}),
        ...(taskAction ? { action: taskAction } : {}),
      };
    });
    const body = { name: name.trim(), autoStart, entityId: entityId || null, tasks: taskBodies };
    if (
      await action.run(
        () =>
          template
            ? api(`/v1/workflow-templates/${template.id}`, { method: 'PUT', json: body })
            : api('/v1/workflow-templates', { method: 'POST', json: { ...body, kind } }),
        t('admin.workflows.saved'),
      )
    )
      onDone(true);
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm"
    >
      <sec.heading id={headingId} ref={heading} tabIndex={-1} className="text-title-3 outline-none">
        {template
          ? t('taskActions.editor.editTitle', { name: template.name })
          : t('admin.workflows.newTitle')}
      </sec.heading>
      {template ? (
        <p className="mt-1 text-callout text-text-secondary">{t('taskActions.editor.editHint')}</p>
      ) : null}
      <form onSubmit={submit} className="mt-4 flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="tpl-name" label={t('admin.name')}>
            {(p) => (
              <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field id="tpl-kind" label={t('admin.workflows.kindLabel')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={kind}
                disabled={!!template}
                onChange={(e) => setKind(e.target.value as Kind)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`admin.workflows.kind.${k}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="tpl-entity" label={t('admin.workflows.entity')} hint={t('admin.workflows.entityHint')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
              >
                <option value="">{t('admin.allEntities')}</option>
                {(entities.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {kind !== 'custom' ? (
          <Checkbox
            id="tpl-auto"
            label={t('admin.workflows.autoStart')}
            hint={t(`admin.workflows.autoStartHint.${kind}`)}
            checked={autoStart}
            onChange={setAutoStart}
          />
        ) : null}
        <ol className="flex flex-col gap-4">
          {tasks.map((x, i) => (
            <li key={x.key} className="flex flex-col gap-4 border-t border-border pt-4">
              <div className="flex items-center gap-2">
                <sec.sub className="mr-auto text-callout font-semibold">
                  {t('admin.workflows.taskN', { n: i + 1 })}
                </sec.sub>
                {tasks.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={t('admin.workflows.removeTask', { n: i + 1 })}
                    onClick={() => setTasks((xs) => xs.filter((y) => y.key !== x.key))}
                  >
                    <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('admin.remove')}
                  </Button>
                ) : null}
              </div>
              <Field id={`task-${x.key}-title`} label={t('admin.workflows.taskTitle')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={200}
                    value={x.title}
                    onChange={(e) => setTask(x.key, { title: e.target.value })}
                  />
                )}
              </Field>
              <Field
                id={`task-${x.key}-description`}
                label={t('admin.workflows.taskDescription')}
                hint={t('admin.optional')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    maxLength={2000}
                    value={x.description}
                    onChange={(e) => setTask(x.key, { description: e.target.value })}
                  />
                )}
              </Field>
              <AssigneeFields
                id={`task-${x.key}-assignee`}
                legend={t('admin.workflows.assignee')}
                types={ASSIGNEE_TYPES}
                labelKey="admin.workflows.assigneeType"
                value={x.assignee}
                onChange={(assignee) => setTask(x.key, { assignee })}
              />
              <ActionFields
                id={`task-${x.key}`}
                value={x.action}
                onChange={(a) => setTask(x.key, { action: a })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <DueFields
                  id={`task-${x.key}`}
                  kind={kind}
                  value={x.due}
                  onChange={(due) => setTask(x.key, { due })}
                />
                <Field
                  id={`task-${x.key}-reminder`}
                  label={t('admin.workflows.reminder')}
                  hint={t('admin.workflows.reminderHint')}
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={60}
                      step={1}
                      value={x.reminder}
                      onChange={(e) => setTask(x.key, { reminder: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </li>
          ))}
        </ol>
        {tasks.length < 100 ? (
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            onClick={() => setTasks((xs) => [...xs, newTask(nextKey.current++)])}
          >
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.workflows.addTask')}
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

function TemplateCard({
  tpl,
  entityName,
  onEdit,
}: {
  tpl: Template;
  entityName: string | null;
  onEdit?: () => void;
}) {
  const t = useT();
  const roleName = useRoleName();
  const locale = useLocale();
  const due = useDueText();
  const assignee = (a: TaskDef['assignee']) =>
    a.type === 'role'
      ? t('admin.workflows.assigneeText.role', { role: roleName(a.value) })
      : t(`admin.workflows.assigneeText.${a.type}`);
  return (
    <SettingsCard
      id={`tpl-${tpl.id}`}
      title={tpl.name}
      description={
        entityName ? t('admin.workflows.forEntity', { entity: entityName }) : t('admin.workflows.forAll')
      }
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {onEdit ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onEdit}
              aria-label={t('taskActions.editor.editNamed', { name: tpl.name })}
            >
              <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('taskActions.editor.edit')}
            </Button>
          ) : null}
          <Badge tone="accent">{t(`admin.workflows.kind.${tpl.kind}`)}</Badge>
          {tpl.kind !== 'custom' ? (
            tpl.autoStart ? (
              <Badge tone="success">{t('admin.workflows.automatic')}</Badge>
            ) : (
              <Badge>{t('admin.workflows.manual')}</Badge>
            )
          ) : null}
        </span>
      }
      container="none"
    >
      <Table dense scrollLabel={t('admin.tableScroll', { name: tpl.name })}>
        <THead>
          <tr>
            <TH>{t('admin.workflows.taskTitle')}</TH>
            <TH>{t('admin.workflows.assignee')}</TH>
            <TH>{t('admin.workflows.due')}</TH>
            <TH>{t('taskActions.editor.opensCol')}</TH>
            <TH>{t('admin.workflows.reminderCol')}</TH>
          </tr>
        </THead>
        <tbody>
          {tpl.tasks.map((x) => (
            <TR key={x.key}>
              <TD>
                <span className="font-semibold">{x.title}</span>
                {x.description ? (
                  <span className="block text-footnote text-text-secondary">{x.description}</span>
                ) : null}
              </TD>
              <TD>{assignee(x.assignee)}</TD>
              <TD>{due(tpl.kind, x)}</TD>
              <TD label={t('taskActions.editor.opensCol')} phone={x.action ? undefined : 'hide'}>
                {x.action ? t(taskActionKindLabel(x.action.kind)) : '—'}
              </TD>
              <TD label={t('admin.workflows.reminderCol')}>
                {x.reminderDaysBefore === undefined
                  ? t('admin.workflows.defaultReminder')
                  : x.reminderDaysBefore === 0
                    ? t('admin.workflows.reminderOnDay')
                    : t('admin.workflows.reminderDays', {
                        amount: formatUnit(x.reminderDaysBefore, 'day', locale),
                      })}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </SettingsCard>
  );
}

/** Onboarding, offboarding and transfer checklists: tasks, who does them and when. */
export default function WorkflowsPage() {
  const t = useT();
  const sec = useSectionLevel();
  const has = usePermission();
  const templates = useApi<Template[]>('/v1/workflow-templates');
  const entities = useOrg('legal-entities');
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const entityName = (id: string | null) =>
    id ? ((entities.data ?? []).find((e) => e.id === id)?.name ?? null) : null;
  return (
    <>
      <PageHeader title={t('admin.section.workflows.title')} lead={t('admin.workflows.lead')}>
        {has('workflows.manage') && !adding ? (
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.workflows.new')}
          </Button>
        ) : null}
      </PageHeader>
      {adding ? (
        <TemplateEditor
          onDone={(saved) => {
            setAdding(false);
            if (saved) templates.reload();
          }}
        />
      ) : null}
      {!templates.data ? (
        <Skeleton className="h-40" />
      ) : templates.data.length === 0 ? (
        <EmptyState
          level={sec.level}
          icon={<ListChecks aria-hidden />}
          title={t('admin.workflows.none')}
          body={t('admin.workflows.noneBody')}
        />
      ) : (
        templates.data.map((tpl) =>
          editing === tpl.id ? (
            <TemplateEditor
              key={tpl.id}
              template={tpl}
              onDone={(saved) => {
                setEditing(null);
                if (saved) templates.reload();
              }}
            />
          ) : (
            <TemplateCard
              key={tpl.id}
              tpl={tpl}
              entityName={entityName(tpl.entityId)}
              onEdit={has('workflows.manage') && !adding && !editing ? () => setEditing(tpl.id) : undefined}
            />
          ),
        )
      )}
    </>
  );
}
