import { addDays, compareDates } from '@thapsus/core/time';
import type { DueRule, FormKind, TaskAction } from '@thapsus/core/task-actions';
import {
  maybeCompleteInstance,
  startWorkflow,
  type WorkflowTaskDef,
} from '../../../modules/workflows/service';
import { insertRows, seedUuid, type SeedCtx } from '../context';

const task = (
  key: string,
  title: string,
  assignee: WorkflowTaskDef['assignee'],
  dueOffsetDays: number,
  extra: {
    reminderDaysBefore?: number;
    description: string;
    action?: TaskAction;
    due?: DueRule;
  },
): WorkflowTaskDef => ({
  key,
  title,
  description: extra.description,
  assignee,
  dueOffsetDays,
  ...(extra.due ? { due: extra.due } : {}),
  ...(extra.reminderDaysBefore !== undefined ? { reminderDaysBefore: extra.reminderDaysBefore } : {}),
  ...(extra.action ? { action: extra.action } : {}),
});
const HR = { type: 'role' as const, value: 'hr_admin' };
const PAYROLL = { type: 'role' as const, value: 'payroll_admin' };
const MANAGER = { type: 'manager' as const };
const EMPLOYEE = { type: 'employee' as const };
const form = (formKind: FormKind): TaskAction => ({ kind: 'form', params: { formKind } });
const kind = (
  k:
    | 'rtw_check'
    | 'i9_section1'
    | 'i9_section2'
    | 'payroll_starter'
    | 'payroll_leaver'
    | 'it_request'
    | 'access_removal',
): TaskAction => ({ kind: k, params: {} }) as TaskAction;

/**
 * Onboarding, offboarding and transfer workflows: templates per entity and instances started by the
 * workflow service (which creates the tasks, notifies assignees and, for offboarding, lets the asset register
 * add a return task per issued asset). Recent joiners' early tasks are done; upcoming joiners' are open.
 */
export async function seedWorkflows(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  // the fictional company's own checklists: every task says what to do, opens the work for the person and,
  // where the law sets the deadline (Form I-9 Section 2), takes it from the jurisdiction pack (ADR-0191, ADR-0193)
  const statementUk = seedUuid('template', 'contract_uk');
  const templates = [
    {
      key: 'onboarding_uk',
      kind: 'onboarding',
      name: 'Onboarding (UK)',
      entity: ids.entity.uk,
      tasks: [
        task('rtw', 'Check right to work before day one', HR, -3, {
          reminderDaysBefore: 5,
          action: kind('rtw_check'),
          description:
            'Before their first day, check that the new starter has the right to work in the UK and record the check on their compliance record. The method and the evidence it needs come from the UK rules; recording the check closes this task.',
        }),
        task('contract', 'Send the statement of main terms', HR, -7, {
          reminderDaysBefore: 3,
          action: { kind: 'send_document', params: { templateId: statementUk } },
          description:
            'Prepare the written statement of main terms from the UK template, check the job title, pay, hours, holiday and notice, then send it to the new starter to sign before they start.',
        }),
        task('details', 'Complete your personal details and emergency contacts', EMPLOYEE, -2, {
          description:
            'Check your name, address and contact details, and add at least one emergency contact, so HR and payroll have what they need before your first day.',
        }),
        task('kit', 'Order laptop, phone or site access card', MANAGER, -5, {
          reminderDaysBefore: 3,
          action: kind('it_request'),
          description:
            'Ask IT for what the new starter needs on day one: a laptop or phone, the accounts for their role and a site access card if they work on site.',
        }),
        task('payroll', 'Set up on payroll (starter checklist)', PAYROLL, 5, {
          action: kind('payroll_starter'),
          description:
            'Give the payroll provider what it needs for the new starter: personal details, start date, pay and the tax and pension information they gave. Thapsus-HR does not run payroll; this hands the starter over to your provider.',
        }),
        task('buddy', 'Introduce a buddy and plan the first week', MANAGER, 0, {
          action: form('first_week_plan'),
          description:
            'Pick a buddy from the team, introduce them, and plan the first week: who they meet, what they learn and what they will have done by Friday.',
        }),
        task('checkin', '30-day check-in', MANAGER, 30, {
          reminderDaysBefore: 5,
          action: form('check_in'),
          due: { anchor: 'start', offsetDays: 30 },
          description:
            'A month in, ask how they are settling in, what is going well and what would help, and agree what to focus on next.',
        }),
        task('probation', 'Probation review', MANAGER, 180, {
          reminderDaysBefore: 14,
          action: form('probation_review'),
          // the week before their probation period ends, whatever its length in their contract
          due: { anchor: 'probation_end', offsetDays: -7 },
          description:
            'Review their probation in the week before it ends: their objectives, the evidence and feedback, and your recommendation to pass, extend or not pass. HR approves the outcome.',
        }),
      ],
    },
    {
      key: 'onboarding_ie',
      kind: 'onboarding',
      name: 'Onboarding (Ireland)',
      entity: ids.entity.ie,
      tasks: [
        task('contract', 'Send the written statement of terms', HR, -7, {
          action: { kind: 'send_document', params: {} },
          description:
            'Prepare the written statement of terms of employment from your Irish template, check the details, and send it to the new starter to sign.',
        }),
        task('details', 'Complete your personal details', EMPLOYEE, -2, {
          description:
            'Check your name, address and contact details so HR and payroll have what they need before your first day.',
        }),
        task('payroll', 'Register the employment with payroll', PAYROLL, 3, {
          action: kind('payroll_starter'),
          description:
            'Give the payroll provider what it needs to register the new employment: personal details, start date, pay and the tax details they gave. Thapsus-HR does not run payroll.',
        }),
        task('checkin', '30-day check-in', MANAGER, 30, {
          action: form('check_in'),
          due: { anchor: 'start', offsetDays: 30 },
          description:
            'A month in, ask how they are settling in, what is going well and what would help, and agree what to focus on next.',
        }),
      ],
    },
    {
      key: 'onboarding_us',
      kind: 'onboarding',
      name: 'Onboarding (US)',
      entity: ids.entity.us,
      tasks: [
        task('i9s1', 'Complete Form I-9 Section 1', EMPLOYEE, 0, {
          reminderDaysBefore: 2,
          action: kind('i9_section1'),
          description:
            'Fill in Section 1 of Form I-9 (Employment Eligibility Verification) no later than your first day of work. HR then checks your documents for Section 2.',
        }),
        task('i9s2', 'Complete Form I-9 Section 2', HR, 0, {
          reminderDaysBefore: 1,
          action: kind('i9_section2'),
          // the deadline is the US pack's (business days after the first day), never a number written here
          due: { anchor: 'start', offsetDays: 0, packDeadline: 'i9_section2' },
          description:
            "Examine the employee's documents and complete Section 2 of Form I-9. The due date is the deadline in the US rules, counted in business days from the first day of work.",
        }),
        task('w4', 'Submit federal and state tax withholding forms', EMPLOYEE, 0, {
          description:
            'Fill in your federal Form W-4 and any state withholding form, so the payroll provider withholds the right tax from your first paycheck.',
        }),
        task('payroll', 'Add to the US payroll', PAYROLL, 2, {
          action: kind('payroll_starter'),
          description:
            'Give the payroll provider what it needs for the new hire: personal details, start date, pay and their withholding forms. Thapsus-HR does not run payroll.',
        }),
        task('checkin', '30-day check-in', MANAGER, 30, {
          action: form('check_in'),
          due: { anchor: 'start', offsetDays: 30 },
          description:
            'A month in, ask how they are settling in, what is going well and what would help, and agree what to focus on next.',
        }),
      ],
    },
    {
      key: 'offboarding',
      kind: 'offboarding',
      name: 'Offboarding',
      entity: null,
      tasks: [
        task('exit', 'Hold an exit interview', HR, -5, {
          action: form('exit_interview'),
          description:
            'Offer the leaver an exit interview before their last day and record what they tell you. They may decline; the answers are seen only by HR.',
        }),
        task('handover', 'Agree a handover plan', MANAGER, -10, {
          action: form('handover'),
          description:
            'Agree with the leaver what they hand over, to whom and by when, so nothing is lost when they go.',
        }),
        task('final_pay', 'Send the leaver summary to payroll', PAYROLL, -3, {
          action: kind('payroll_leaver'),
          description:
            'Send the payroll provider what it needs for the final pay: the last day, notice dates, holiday owed or taken in advance, unpaid absence and late pay changes. The provider works out the final pay.',
        }),
        task('access', 'Remove system and building access', HR, 0, {
          action: kind('access_removal'),
          description:
            "On their last day, end the leaver's access to company systems and buildings, collect their equipment, and note anything done by hand.",
        }),
      ],
    },
    {
      key: 'transfer',
      kind: 'transfer',
      name: 'Internal transfer',
      entity: null,
      tasks: [
        task('handover', 'Hand over current work', MANAGER, -5, {
          action: form('handover'),
          description:
            'Before the move, agree what they hand over in their current team, to whom and by when.',
        }),
        task('welcome', 'Welcome to the new team', MANAGER, 0, {
          action: form('transfer_welcome'),
          description:
            'On their first day in the new team, introduce them, explain how the team works and plan their first weeks.',
        }),
      ],
    },
  ];
  const tplId: Record<string, string> = {};
  for (const t of templates) tplId[t.key] = seedUuid('workflow-template', t.key);
  await insertRows(
    tx,
    'app.workflow_templates',
    templates.map((t) => ({
      id: tplId[t.key],
      kind: t.kind,
      name: t.name,
      tasks: t.tasks,
      auto_start: t.kind !== 'transfer',
      entity_id: t.entity,
    })),
    { json: ['tasks'] },
  );
  let started = 0;
  const onboardingFor = (entity: string) =>
    entity === 'ie' ? 'onboarding_ie' : entity === 'us' ? 'onboarding_us' : 'onboarding_uk';
  // upcoming joiners and recent joiners (onboarding anchored on the first day)
  for (const p of plan.people.filter((x) => x.kind === 'upcoming_starter' || x.recentStarter)) {
    const id = await startWorkflow(
      tx,
      tplId[onboardingFor(p.entity)]!,
      ids.employee[p.idx]!,
      p.startDate,
      ids.user.hr_admin,
      { book: ctx.book },
    );
    if (!id) continue;
    started++;
    await tx.exec('UPDATE app.workflow_instances SET created_at = $2 WHERE id = $1', [
      id,
      `${addDays(p.startDate, -14)}T09:00:00Z`,
    ]);
    await tx.exec(`UPDATE app.tasks SET created_at = $2 WHERE source = 'workflow' AND source_id = $1`, [
      id,
      `${addDays(p.startDate, -14)}T09:00:00Z`,
    ]);
    // everything due more than three days ago is done
    await tx.exec(
      `UPDATE app.tasks SET status = 'done', completed_at = (due_on - 1)::timestamptz + interval '15 hours'
        WHERE source = 'workflow' AND source_id = $1 AND due_on < $2::date - 3`,
      [id, anchor],
    );
    await maybeCompleteInstance(tx, id);
  }
  // a joiner from last year whose onboarding finished
  const done = plan.people.find(
    (p) =>
      p.kind === 'roster' &&
      p.entity === 'uk' &&
      compareDates(p.startDate, addDays(anchor, -400)) > 0 &&
      compareDates(p.startDate, addDays(anchor, -200)) < 0,
  );
  if (done) {
    const id = await startWorkflow(
      tx,
      tplId.onboarding_uk!,
      ids.employee[done.idx]!,
      done.startDate,
      ids.user.hr_admin,
      { book: ctx.book },
    );
    if (id) {
      await tx.exec(
        `UPDATE app.tasks SET status = 'done', completed_at = (due_on)::timestamptz + interval '12 hours' WHERE source = 'workflow' AND source_id = $1`,
        [id],
      );
      await maybeCompleteInstance(tx, id);
      await tx.exec(
        `UPDATE app.notifications SET read_at = now() - interval '150 days' WHERE dedupe_key LIKE $1`,
        [`wf:${id}:%`],
      );
      started++;
    }
  }
  // people leaving soon (offboarding; the asset register adds a return task per issued asset)
  for (const p of plan.people.filter((x) => x.kind === 'roster' && x.endDate)) {
    const id = await startWorkflow(
      tx,
      tplId.offboarding!,
      ids.employee[p.idx]!,
      p.endDate!,
      ids.user.hr_admin,
      { book: ctx.book },
    );
    if (id) started++;
  }
  // the future-dated transfer to Edinburgh
  const transfer = plan.futureChanges.find((c) => c.kind === 'transfer');
  if (transfer) {
    const id = await startWorkflow(
      tx,
      tplId.transfer!,
      ids.employee[transfer.personIdx]!,
      transfer.effectiveDate,
      ids.user.hr_admin,
      { book: ctx.book },
    );
    if (id) started++;
  }
  ctx.counts.workflowTemplates = templates.length;
  ctx.counts.workflowsStarted = started;
}
