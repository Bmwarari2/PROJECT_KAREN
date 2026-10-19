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
  'app.compliance_requirements',
  'app.eeo_job_categories',
  'app.retention_policies',
  'app.privacy_notices',
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
  'app.ai_questions',
  'vault.records',
  'audit.events',
  'app.worked_hours',
  'app.rtw_checks',
  'app.i9_records',
  'app.flsa_attestations',
  'app.compliance_records',
  'app.pay_report_inputs',
  'app.law_change_reads',
  'app.pay_period_snapshots',
  'app.payroll_exports',
  'app.payslips',
  'app.it_accounts',
  'app.it_operations',
  'app.integration_calls',
  'app.asset_assignments',
  'app.saved_reports',
  'app.report_schedules',
  'app.dsr_requests',
  'app.legal_holds',
  'app.incidents',
  'app.subprocessor_subscriptions',
  'app.i9_records',
  // phase 10: support tickets (content submitted by people) and billing contacts
  'app.support_tickets',
  'app.support_ticket_messages',
  'app.support_ticket_attachments',
  'app.billing_contacts',
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
  // Ask HR retrieval index, derived from (never-copied) documents and rebuilt by its job.
  'app.ai_policy_chunks',
  'app.ai_index_state',
  'audit.chain_heads',
  'app.pay_periods',
  'app.payroll_deliveries',
  'app.payslip_batches',
  'app.assets',
  'app.report_runs',
  'app.export_deliveries',
  'app.account_closures',
  'app.company_exports',
  'app.retention_runs',
  'app.dpa_acceptances',
  // phase 10: billing state is never copied (a sandbox must never bill or reach the billing provider)
  'app.billing_accounts',
  'app.billing_account_entities',
  'app.billing_subscriptions',
  'app.billing_invoices',
  'app.billing_webhook_events',
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
  'app.payroll_connectors',
  'app.integration_credentials',
  'app.integration_oauth_states',
  'app.it_connections',
  'app.it_mapping_rules',
  'app.data_exports',
  'app.export_destinations',
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
