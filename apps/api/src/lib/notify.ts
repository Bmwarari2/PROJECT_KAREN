import { enqueueJob, type Tx } from '@thapsus/db';

export interface NotifyInput {
  userIds: string[];
  kind: string;
  titleKey: string;
  params?: Record<string, string | number>;
  link?: string;
  /** Prevents duplicates (e.g. one reminder per document per threshold). */
  dedupeKey?: string;
  email?: boolean;
}

/**
 * Creates in-app notifications (inside the caller's transaction) and enqueues idempotent delivery
 * (email + web push) per notification. Message text is resolved from the catalogue at delivery time
 * in each recipient's locale.
 */
export async function notify(tx: Tx, n: NotifyInput): Promise<string[]> {
  const ids: string[] = [];
  for (const userId of n.userIds) {
    const row = await tx.maybe<{ id: string }>(
      `INSERT INTO app.notifications (tenant_id, user_id, kind, title_key, params, link, dedupe_key)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [userId, n.kind, n.titleKey, JSON.stringify(n.params ?? {}), n.link ?? null, n.dedupeKey ?? null],
    );
    if (!row) continue;
    ids.push(row.id);
    if (n.email !== false) await enqueueJob(tx, 'notifications.deliver', row.id, { notificationId: row.id });
  }
  return ids;
}

/** Users holding a role key (optionally scoped to an entity via scope values). */
export async function usersWithRole(tx: Tx, roleKey: string): Promise<string[]> {
  const rows = await tx.query<{ user_id: string }>(
    `SELECT DISTINCT a.user_id FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
       JOIN app.users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id WHERE r.key = $1 AND u.status = 'active'`,
    [roleKey],
  );
  return rows.map((r) => r.user_id);
}

export async function userForEmployee(tx: Tx, employeeId: string | null | undefined): Promise<string | undefined> {
  if (!employeeId) return undefined;
  return (await tx.maybe<{ id: string }>(`SELECT id FROM app.users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId]))?.id;
}

export async function createTask(
  tx: Tx,
  t: {
    source: string;
    sourceId?: string | null;
    title: string;
    description?: string;
    subjectEmployeeId?: string | null;
    assigneeUserId?: string | null;
    assigneeRole?: string | null;
    /** The person the task is for, kept so it can be handed to their sign-in once they have one. */
    assigneeEmployeeId?: string | null;
    dueOn?: string | null;
    /** Days before dueOn to send the "due soon" reminder (null = the default lead time). */
    reminderDaysBefore?: number | null;
    link?: string;
    dedupeKey?: string;
  },
): Promise<string | undefined> {
  const row = await tx.maybe<{ id: string }>(
    `INSERT INTO app.tasks (tenant_id, source, source_id, title, description, subject_employee_id, assignee_user_id, assignee_role, due_on, link, dedupe_key, assignee_employee_id, reminder_days_before)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [t.source, t.sourceId ?? null, t.title, t.description ?? null, t.subjectEmployeeId ?? null, t.assigneeUserId ?? null, t.assigneeRole ?? null, t.dueOn ?? null, t.link ?? null, t.dedupeKey ?? null, t.assigneeEmployeeId ?? null, t.reminderDaysBefore ?? null],
  );
  return row?.id;
}
