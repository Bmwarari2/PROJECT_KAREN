import { addDays, compareDates } from '@thapsus/core/time';
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
  reminderDaysBefore?: number,
): WorkflowTaskDef => ({
  key,
  title,
  assignee,
  dueOffsetDays,
  ...(reminderDaysBefore !== undefined ? { reminderDaysBefore } : {}),
});
const HR = { type: 'role' as const, value: 'hr_admin' };
const PAYROLL = { type: 'role' as const, value: 'payroll_admin' };
const MANAGER = { type: 'manager' as const };
const EMPLOYEE = { type: 'employee' as const };

/**
 * Onboarding, offboarding and transfer workflows: templates per entity and instances started by the
 * workflow service (which creates the tasks, notifies assignees and, for offboarding, lets the asset register
 * add a return task per issued asset). Recent joiners' early tasks are done; upcoming joiners' are open.
 */
export async function seedWorkflows(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  const templates = [
    {
      key: 'onboarding_uk',
      kind: 'onboarding',
      name: 'Onboarding (UK)',
      entity: ids.entity.uk,
      tasks: [
        task('rtw', 'Check right to work before day one', HR, -3, 5),
        task('contract', 'Send the statement of main terms', HR, -7, 3),
        task('details', 'Complete your personal details and emergency contacts', EMPLOYEE, -2),
        task('kit', 'Order laptop, phone or site access card', MANAGER, -5, 3),
        task('payroll', 'Set up on payroll (starter checklist)', PAYROLL, 5),
        task('buddy', 'Introduce a buddy and plan the first week', MANAGER, 0),
        task('checkin', '30-day check-in', MANAGER, 30, 5),
        task('probation', 'Probation review', MANAGER, 180, 14),
      ],
    },
    {
      key: 'onboarding_ie',
      kind: 'onboarding',
      name: 'Onboarding (Ireland)',
      entity: ids.entity.ie,
      tasks: [
        task('contract', 'Send the written statement of terms', HR, -7),
        task('details', 'Complete your personal details', EMPLOYEE, -2),
        task('payroll', 'Register the employment with payroll', PAYROLL, 3),
        task('checkin', '30-day check-in', MANAGER, 30),
      ],
    },
    {
      key: 'onboarding_us',
      kind: 'onboarding',
      name: 'Onboarding (US)',
      entity: ids.entity.us,
      tasks: [
        task('i9s1', 'Complete Form I-9 Section 1', EMPLOYEE, 0, 2),
        task('i9s2', 'Complete Form I-9 Section 2 (within three business days)', HR, 3, 1),
        task('w4', 'Submit federal and state tax withholding forms', EMPLOYEE, 0),
        task('payroll', 'Add to the US payroll', PAYROLL, 2),
        task('checkin', '30-day check-in', MANAGER, 30),
      ],
    },
    {
      key: 'offboarding',
      kind: 'offboarding',
      name: 'Offboarding',
      entity: null,
      tasks: [
        task('exit', 'Hold an exit interview', HR, -5),
        task('handover', 'Agree a handover plan', MANAGER, -10),
        task('final_pay', 'Calculate final pay and holiday pay owed', PAYROLL, -3),
        task('access', 'Remove system and building access', HR, 0),
      ],
    },
    {
      key: 'transfer',
      kind: 'transfer',
      name: 'Internal transfer',
      entity: null,
      tasks: [
        task('handover', 'Hand over current work', MANAGER, -5),
        task('welcome', 'Welcome to the new team', MANAGER, 0),
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
    );
    if (id) started++;
  }
  ctx.counts.workflowTemplates = templates.length;
  ctx.counts.workflowsStarted = started;
}
