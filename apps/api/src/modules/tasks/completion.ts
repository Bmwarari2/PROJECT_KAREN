import { writeAudit, type Tx } from '@thapsus/db';
import {
  isTaskActionKind,
  isTaskRecordType,
  type TaskActionKind,
  type TaskRecordRef,
  type TaskRecordType,
} from '@thapsus/core/task-actions';

/**
 * Tasks close themselves (ADR-0192). A task may be linked to a record (`record_type`, `record_id`): the
 * module that owns the record calls `completeTasksFor` in the same transaction as the change that
 * completes it — a document signed, an asset acknowledged or returned, a right-to-work check recorded, an
 * HR request resolved — and every open task linked to it is closed and audited. Owning modules match on
 * the record type (stable across kinds) and may narrow by action kind and by the person the task is about.
 */
export interface TaskCompletion {
  /** The record's type; required unless `kind` is given. */
  recordType?: TaskRecordType;
  /** The record's id (the person's employee id for person-level obligations, see TASK_RECORD_TYPES). */
  recordId: string;
  /** Only tasks with these action kinds. */
  kind?: TaskActionKind | TaskActionKind[];
  /** Only tasks about this person (for record ids shared by many people: requirements, templates). */
  subjectEmployeeId?: string | null;
  /** The user whose change completed the record; null or omitted for the system. */
  by?: string | null;
  /** The audited reason, normally the owning change's audit action (e.g. `asset.acknowledged`). */
  reason: string;
  /** `cancelled` when the work is no longer needed (e.g. an asset returned before it was acknowledged). */
  status?: 'done' | 'cancelled';
  /** When it happened (defaults to the transaction's time). */
  at?: string;
}

export interface ClosedTask {
  id: string;
  source: string;
  sourceId: string | null;
}

type Closing = Pick<TaskCompletion, 'by' | 'reason' | 'status' | 'at'>;

/** Closes the open tasks a WHERE clause selects (its parameters start at $4), audits each and completes workflows. */
async function close(tx: Tx, where: string, params: unknown[], c: Closing): Promise<ClosedTask[]> {
  const status = c.status ?? 'done';
  const rows = await tx.query<{
    id: string;
    source: string;
    source_id: string | null;
    record_type: string | null;
    record_id: string | null;
  }>(
    `UPDATE app.tasks SET status = $1, completed_at = coalesce($2::timestamptz, now()),
            completed_by = CASE WHEN $1 = 'done' THEN $3::uuid END, completed_via = 'record'
      WHERE status = 'open' AND ${where}
      RETURNING id, source, source_id, record_type, record_id`,
    [status, c.at ?? null, c.by ?? null, ...params],
  );
  for (const r of rows)
    await writeAudit(tx, {
      actorType: c.by ? 'user' : 'system',
      actorId: c.by ?? null,
      action: status === 'done' ? 'task.completed' : 'task.cancelled',
      targetType: 'task',
      targetId: r.id,
      diff: { via: 'record', recordType: r.record_type, recordId: r.record_id, reason: c.reason },
    });
  const instances = new Set(
    rows.filter((r) => r.source === 'workflow' && r.source_id).map((r) => r.source_id!),
  );
  for (const id of instances) await completeWorkflowInstanceIfDone(tx, id);
  return rows.map((r) => ({ id: r.id, source: r.source, sourceId: r.source_id }));
}

/**
 * Closes every open task linked to a record and audits each one (`task.completed` or `task.cancelled`,
 * `via: record`). Workflow instances whose last open task this was are completed. Idempotent: tasks that
 * are already closed are left alone. Returns the tasks it closed.
 */
export async function completeTasksFor(tx: Tx, c: TaskCompletion): Promise<ClosedTask[]> {
  const kinds = c.kind === undefined ? null : Array.isArray(c.kind) ? c.kind : [c.kind];
  if (!c.recordType && !kinds?.length) throw new Error('completeTasksFor needs a record type or a kind');
  if (c.recordType && !isTaskRecordType(c.recordType)) throw new Error(`Unknown record type ${c.recordType}`);
  if (kinds?.some((k) => !isTaskActionKind(k))) throw new Error('Unknown task action kind');
  return close(
    tx,
    `record_id = $4 AND ($5::text IS NULL OR record_type = $5) AND ($6::text[] IS NULL OR action_kind = ANY($6))
       AND ($7::uuid IS NULL OR subject_employee_id = $7)`,
    [c.recordId, c.recordType ?? null, kinds, c.subjectEmployeeId ?? null],
    c,
  );
}

/**
 * Closes one task by its id when the page it opened finished the work (pages receive `task=<id>`, see the
 * registry's hrefs). Only an open task is closed; the caller has already checked that the user may do the
 * work and that the task is about the record it completed. Returns whether it closed.
 */
export async function completeTaskById(tx: Tx, taskId: string, c: Closing): Promise<boolean> {
  return (await close(tx, 'id = $4', [taskId], c)).length > 0;
}

/** Links an open task to the record that will close it (e.g. the signature request a send screen created). */
export async function linkTaskRecord(tx: Tx, taskId: string, record: TaskRecordRef): Promise<boolean> {
  if (!isTaskRecordType(record.type)) throw new Error(`Unknown record type ${record.type}`);
  const row = await tx.maybe<{ id: string }>(
    `UPDATE app.tasks SET record_type = $2, record_id = $3 WHERE id = $1 AND status = 'open' RETURNING id`,
    [taskId, record.type, record.id],
  );
  return !!row;
}

/** Completes a workflow instance once none of its tasks is open. */
export async function completeWorkflowInstanceIfDone(tx: Tx, instanceId: string) {
  const open = await tx.maybe(
    `SELECT 1 FROM app.tasks WHERE source = 'workflow' AND source_id = $1 AND status = 'open' LIMIT 1`,
    [instanceId],
  );
  if (!open)
    await tx.exec(
      `UPDATE app.workflow_instances SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'active'`,
      [instanceId],
    );
}
