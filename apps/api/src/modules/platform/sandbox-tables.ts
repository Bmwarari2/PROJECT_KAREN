/**
 * Data classification of every tenant-scoped table for sandboxes (brief §6.10, ADR-0096).
 *
 *  - config:      copied to a sandbox (company settings and structure; references to people removed)
 *  - personal:    personal data — NEVER copied; the sandbox gets synthetic people instead
 *  - operational: queues, logs, caches and history — never copied
 *  - secret:      credentials, keys, tokens and customer integrations — never copied (a sandbox must not
 *                 sign in through production SSO or deliver to production webhooks/SIEMs)
 *
 * apps/api/test/sandbox.int.test.ts enumerates the catalog: a new table that is not classified here
 * fails the build. Add new tables deliberately (most tables holding anything about a person are
 * `personal`). CONFIG_TABLES is ordered parents-first for copying.
 */
export type TableClass = 'config' | 'personal' | 'operational' | 'secret';

export const CONFIG_TABLES = [
  'app.tenants',
  'app.roles',
  'app.legal_entities',
  'app.locations',
  'app.departments',
  'app.cost_centres',
  'app.grades',
  'app.positions',
  'app.custom_field_definitions',
  'app.custom_object_types',
  'app.document_folders',
  'app.document_templates',
  'app.workflow_templates',
  'app.approval_policies',
  'app.automation_rules',
  'app.leave_types',
  'app.leave_policies',
  'app.company_calendars',
  'app.cover_rules',
  'app.absence_triggers',
  'app.rota_templates',
] as const;

const PERSONAL = [
  'app.users',
  'app.employees',
  'app.employee_personal',
  'app.employee_jobs',
  'app.employee_pay',
  'app.employee_contracts',
  'app.reporting_lines',
  'app.emergency_contacts',
  'app.custom_field_values',
  'app.custom_object_records',
  'app.documents',
  'app.signature_requests',
  'app.leave_requests',
  'app.leave_adjustments',
  'app.leave_policy_assignments',
  'app.sickness_records',
  'app.fmla_cases',
  'app.shifts',
  'app.availability',
  'app.shift_swaps',
  'app.clock_events',
  'app.kiosk_pins',
  'app.timesheets',
  'app.working_time_opt_outs',
  'app.tasks',
  'app.notifications',
  'app.workflow_instances',
  'app.approval_requests',
  'app.approval_steps',
  'app.delegations',
  'app.role_assignments',
  'app.groups',
  'app.group_members',
  'app.push_subscriptions',
  'app.import_batches',
  'app.automation_runs',
  'vault.records',
  'audit.events',
] as const;

const OPERATIONAL = [
  'app.outbox',
  'app.jobs',
  'app.idempotency_keys',
  'app.timesheet_exports',
  'app.webhook_deliveries',
  'app.webhook_attempts',
  'app.audit_stream_batches',
  'app.sandboxes',
  'audit.chain_heads',
] as const;

const SECRET = [
  'app.password_credentials',
  'app.totp_factors',
  'app.passkeys',
  'app.auth_challenges',
  'app.sessions',
  'app.magic_links',
  'app.sso_connections',
  'app.scim_tokens',
  'app.verified_domains',
  'app.ics_tokens',
  'app.kiosks',
  'app.support_grants',
  'app.api_keys',
  'app.oauth_clients',
  'app.oauth_access_tokens',
  'app.webhook_endpoints',
  'app.audit_streams',
] as const;

export const TABLE_CLASSES: Readonly<Record<string, TableClass>> = Object.freeze({
  ...Object.fromEntries(CONFIG_TABLES.map((t) => [t, 'config'])),
  ...Object.fromEntries(PERSONAL.map((t) => [t, 'personal'])),
  ...Object.fromEntries(OPERATIONAL.map((t) => [t, 'operational'])),
  ...Object.fromEntries(SECRET.map((t) => [t, 'secret'])),
} as Record<string, TableClass>);

/** Columns and JSON keys that point at a person; removed from copied configuration. */
const PERSON_REF = /^(employee_?ids?|user_?ids?|manager_?ids?|approver_?user_?ids?|(created|updated|requested|started|recorded|completed|decided)_?by)$/i;

/** Removes person references from copied configuration (approvers/assignees become the HR admin role). */
export function scrubPersonRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPersonRefs);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ((o.type === 'user' || o.type === 'employee_id') && typeof o.value === 'string') return { ...o, type: 'role', value: 'hr_admin' };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, PERSON_REF.test(k) ? null : scrubPersonRefs(v)]));
  }
  return value;
}
