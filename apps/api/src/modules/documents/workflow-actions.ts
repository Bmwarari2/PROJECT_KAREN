import { newDocumentHref } from '@thapsus/core/documents';
import { workflowStartHooks, type WorkflowTaskDef } from '../workflows/service';

/**
 * The `send_document` task action (16.14, ADR-0195): a workflow step such as the UK onboarding "Send the statement
 * of main terms" names the template to send. When the workflow starts, its task links to the send page with the
 * person, the template and the task already chosen (`/app/people/<id>/documents/new?template=…&task=…`); the
 * signature request keeps the task id and closes the task when the document is complete. The task action registry
 * of Phase 16 part B renders the "Prepare and send" button from the same link.
 */
export const SEND_DOCUMENT = 'send_document';

workflowStartHooks.push(async (tx, instance) => {
  const tpl = await tx.maybe<{ tasks: WorkflowTaskDef[] }>(
    `SELECT t.tasks FROM app.workflow_instances i JOIN app.workflow_templates t ON t.tenant_id = i.tenant_id AND t.id = i.template_id WHERE i.id = $1`,
    [instance.id],
  );
  for (const def of tpl?.tasks ?? []) {
    const templateId = def.action?.kind === SEND_DOCUMENT ? def.action.params?.templateId : undefined;
    if (typeof templateId !== 'string') continue;
    const tasks = await tx.query<{ id: string }>(
      `SELECT id FROM app.tasks WHERE source = 'workflow' AND source_id = $1 AND dedupe_key LIKE $2`,
      [instance.id, `wf:${instance.id}:${def.key}:%`],
    );
    for (const task of tasks)
      await tx.exec('UPDATE app.tasks SET link = $2 WHERE id = $1', [
        task.id,
        newDocumentHref({ employeeId: instance.employeeId, templateId, taskId: task.id }),
      ]);
  }
});
