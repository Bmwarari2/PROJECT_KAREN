import type { Tx } from '@thapsus/db';
import { addDays } from '@thapsus/core/time';
import { createTask } from '../../lib/notify';

/**
 * The return-to-work conversation after a sickness absence: a task for the manager that says what to do,
 * comes from Absence, opens the conversation (part G's form; the person's time off until then) and closes
 * when the conversation is recorded (ADR-0191, ADR-0192).
 */
export async function createReturnToWorkTask(
  tx: Tx,
  sicknessId: string,
  employeeId: string,
  managerUserId: string,
  lastDay: string,
) {
  const name =
    (
      await tx.maybe<{ display_name: string }>('SELECT display_name FROM app.employees WHERE id = $1', [
        employeeId,
      ])
    )?.display_name ?? '';
  return createTask(tx, {
    source: 'absence',
    sourceId: sicknessId,
    titleKey: 'taskActions.text.absence.returnToWork.title',
    descriptionKey: 'taskActions.text.absence.returnToWork.description',
    textParams: { name },
    subjectEmployeeId: employeeId,
    assigneeUserId: managerUserId,
    // a workspace setting in part G (16.27); two days after the last day of absence until then
    dueOn: addDays(lastDay, 2),
    action: { kind: 'form', params: { formKind: 'return_to_work' } },
    record: { type: 'return_to_work', id: sicknessId },
    dedupeKey: `rtw:${sicknessId}`,
  });
}
