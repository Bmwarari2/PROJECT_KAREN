import { enqueueJob, type Tx } from '@thapsus/db';
import { isLocale, t as translate, type Locale } from '@thapsus/core/i18n';
import { targetHref, type LinkTarget } from '@thapsus/core/links';
import {
  parseTaskAction,
  taskActionRecord,
  type TaskAction,
  type TaskRecordRef,
  type TaskSource,
} from '@thapsus/core/task-actions';
import type { StoredDueRule } from '../modules/tasks/due';

export interface NotifyInput {
  userIds: string[];
  kind: string;
  titleKey: string;
  params?: Record<string, string | number>;
  /**
   * What the notification is about (ADR-0160). The bell, the notifications page, e-mails and web push
   * open its page (`@thapsus/core/links`); `link` is only needed for a page that is not a target's own.
   */
  target?: LinkTarget | ((userId: string) => LinkTarget | undefined);
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
    const target = typeof n.target === 'function' ? n.target(userId) : n.target;
    const row = await tx.maybe<{ id: string }>(
      `INSERT INTO app.notifications (tenant_id, user_id, kind, title_key, params, link, dedupe_key, target_type, target_id)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [
        userId,
        n.kind,
        n.titleKey,
        JSON.stringify(n.params ?? {}),
        n.link ?? targetHref(target) ?? null,
        n.dedupeKey ?? null,
        target?.type ?? null,
        target?.id ?? null,
      ],
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

export async function userForEmployee(
  tx: Tx,
  employeeId: string | null | undefined,
): Promise<string | undefined> {
  if (!employeeId) return undefined;
  return (
    await tx.maybe<{ id: string }>(
      `SELECT id FROM app.users WHERE employee_id = $1 AND status = 'active' LIMIT 1`,
      [employeeId],
    )
  )?.id;
}

/** A new task (ADR-0191 to ADR-0193). Text is either the source's own words or catalogue keys. */
export interface NewTask {
  source: TaskSource;
  sourceId?: string | null;
  /** The task's own words (a template's or a person's); required unless `titleKey` is given. */
  title?: string;
  description?: string;
  /** System-made tasks: catalogue keys, rendered in each reader's locale (`textParams` fill them in). */
  titleKey?: string;
  descriptionKey?: string;
  textParams?: Record<string, string | number>;
  subjectEmployeeId?: string | null;
  assigneeUserId?: string | null;
  assigneeRole?: string | null;
  /** The person the task is for, kept so it can be handed to their sign-in once they have one. */
  assigneeEmployeeId?: string | null;
  dueOn?: string | null;
  /** How `dueOn` was worked out, so it follows the person's dates when they change. */
  dueRule?: StoredDueRule | null;
  /** Days before dueOn to send the "due soon" reminder (null = the default lead time). */
  reminderDaysBefore?: number | null;
  /** The main button (packages/core/src/task-actions.ts). */
  action?: TaskAction | null;
  /** The record that closes the task (ADR-0192); defaults to the record the action's kind links. */
  record?: TaskRecordRef | null;
  link?: string;
  dedupeKey?: string;
}

async function workspaceLocale(tx: Tx): Promise<Locale> {
  const row = await tx.maybe<{ default_locale: string }>('SELECT default_locale FROM app.tenants');
  return isLocale(row?.default_locale) ? row.default_locale : 'en-GB';
}

/**
 * Creates a task (idempotent per dedupe key). A title or description given as catalogue keys is also
 * stored rendered in the workspace's locale, for exports, e-mails and older clients.
 */
export async function createTask(tx: Tx, t: NewTask): Promise<string | undefined> {
  const locale = t.titleKey || t.descriptionKey ? await workspaceLocale(tx) : 'en-GB';
  const params = t.textParams ?? {};
  const title = t.title ?? (t.titleKey ? translate(locale, t.titleKey, params) : '');
  if (!title.trim()) throw new Error('A task needs a title or a title key');
  const description =
    t.description ?? (t.descriptionKey ? translate(locale, t.descriptionKey, params) : null);
  const action = t.action ? parseTaskAction(t.action) : null;
  if (t.action && !action) throw new Error(`Invalid task action ${t.action.kind}`);
  const record =
    t.record === undefined
      ? action
        ? taskActionRecord(action, { taskId: '', subjectEmployeeId: t.subjectEmployeeId ?? null })
        : null
      : t.record;
  const row = await tx.maybe<{ id: string }>(
    `INSERT INTO app.tasks (tenant_id, source, source_id, title, description, subject_employee_id, assignee_user_id, assignee_role, due_on, link, dedupe_key,
                            assignee_employee_id, reminder_days_before, action_kind, action_params, record_type, record_id, title_key, description_key, text_params, due_rule)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [
      t.source,
      t.sourceId ?? null,
      title,
      description,
      t.subjectEmployeeId ?? null,
      t.assigneeUserId ?? null,
      t.assigneeRole ?? null,
      t.dueOn ?? null,
      t.link ?? null,
      t.dedupeKey ?? null,
      t.assigneeEmployeeId ?? null,
      t.reminderDaysBefore ?? null,
      action?.kind ?? null,
      JSON.stringify(action?.params ?? {}),
      record?.type ?? null,
      record?.id ?? null,
      t.titleKey ?? null,
      t.descriptionKey ?? null,
      JSON.stringify(params),
      t.dueRule ? JSON.stringify(t.dueRule) : null,
    ],
  );
  // a request to HR is its own record: it closes when HR resolves it
  if (row && t.source === 'hr_request' && t.record === undefined)
    await tx.exec(`UPDATE app.tasks SET record_type = 'hr_request', record_id = id WHERE id = $1`, [row.id]);
  return row?.id;
}
