import type { RetentionCategory } from '@thapsus/rules';
import type { Tx } from '@thapsus/db';

/**
 * How every tenant table relates to a person. One map drives the per-person access export, the
 * erasure workflow and the completeness test (test/privacy-coverage.int.test.ts), which enumerates the
 * catalog and FAILS when a table gains a column referencing an employee or user that is not listed here.
 *
 *  - subject: columns that identify the data subject; matching rows are exported in full (minus `omit`).
 *  - actor: columns recording that the person did something to someone else's record; exported as counts
 *    only, so an access export never discloses other people's data.
 *  - erase: what erasure does to subject rows once no legal hold or statutory retention applies.
 *  - category: the retention category whose statutory minimum can delay erasure.
 */
export type SubjectKind = 'employee' | 'user';
export interface Link {
  column: string;
  kind: SubjectKind;
}
export type EraseAction = { delete: true } | { anonymise: Record<string, string | null> } | { keep: string };
export interface TableRule {
  subject: Link[];
  actor?: string[];
  erase: EraseAction;
  category: RetentionCategory | 'contact' | 'account' | 'accountability';
  omit?: string[];
}

const E = (column = 'employee_id'): Link => ({ column, kind: 'employee' });
const U = (column = 'user_id'): Link => ({ column, kind: 'user' });
const DEL: EraseAction = { delete: true };
const ERASED = 'Erased person';

/** Values matching this pattern are credentials or ciphertext and are never exported. */
export const SECRET_COLUMN =
  /hash|secret|token|envelope|ciphertext|public_key|credential|^pin|_pin$|challenge|p256dh|^auth$|counter/i;

export const SUBJECT_TABLES: Record<string, TableRule> = {
  // ---- core HR ------------------------------------------------------------------------------------
  'app.employees': {
    subject: [E('id')],
    actor: ['manager_id'],
    category: 'personnel_records',
    erase: {
      anonymise: {
        display_name: ERASED,
        preferred_name: null,
        work_email: null,
        work_phone: null,
        employee_number: '=erased',
      },
    },
  },
  'app.employee_personal': {
    subject: [E()],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: {
      anonymise: {
        legal_first_name: 'Erased',
        legal_last_name: 'person',
        preferred_name: null,
        pronouns: null,
        date_of_birth: null,
        personal_email: null,
        personal_phone: null,
        address: null,
        nationality: null,
      },
    },
  },
  'app.employee_jobs': {
    subject: [E()],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: {
      keep: 'no direct identifiers once identity fields are erased; kept pseudonymised for workforce statistics',
    },
  },
  'app.employee_contracts': {
    subject: [E()],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: { keep: 'no direct identifiers once identity fields are erased; kept pseudonymised' },
  },
  'app.employee_pay': { subject: [E()], actor: ['created_by'], category: 'payroll_records', erase: DEL },
  'app.reporting_lines': {
    subject: [E()],
    actor: ['manager_id', 'created_by'],
    category: 'personnel_records',
    erase: { keep: 'organisation history; identifiers erased on the employee record' },
  },
  'app.emergency_contacts': { subject: [E()], actor: ['created_by'], category: 'contact', erase: DEL },
  'app.custom_field_values': {
    subject: [E('record_id')],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.custom_object_records': {
    subject: [E()],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.documents': { subject: [E()], actor: ['created_by'], category: 'personnel_records', erase: DEL },
  'app.signature_requests': {
    subject: [E('signer_employee_id'), U('signer_user_id')],
    actor: ['requested_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.workflow_instances': {
    subject: [E()],
    actor: ['started_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.approval_requests': {
    subject: [E('subject_employee_id')],
    actor: ['requested_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.approval_steps': {
    subject: [],
    actor: ['decided_by'],
    category: 'accountability',
    erase: { keep: 'decisions about other people' },
  },
  'app.tasks': {
    subject: [E('subject_employee_id'), U('assignee_user_id'), E('assignee_employee_id')],
    actor: ['completed_by'],
    category: 'personnel_records',
    erase: DEL,
  },

  // ---- time off and absence -----------------------------------------------------------------------
  'app.leave_requests': { subject: [E()], actor: ['requested_by'], category: 'leave_records', erase: DEL },
  'app.leave_adjustments': { subject: [E()], actor: ['created_by'], category: 'leave_records', erase: DEL },
  'app.leave_policy_assignments': { subject: [E()], category: 'leave_records', erase: DEL },
  'app.fmla_cases': { subject: [E()], actor: ['created_by'], category: 'leave_records', erase: DEL },
  'app.sickness_records': {
    subject: [E()],
    actor: ['recorded_by'],
    category: 'sickness_records',
    erase: DEL,
  },

  // ---- rotas and time ------------------------------------------------------------------------------
  'app.shifts': { subject: [E()], category: 'time_records', erase: DEL },
  'app.shift_swaps': {
    subject: [E('from_employee_id'), E('to_employee_id')],
    actor: ['requested_by'],
    category: 'time_records',
    erase: DEL,
  },
  'app.availability': { subject: [E()], category: 'time_records', erase: DEL },
  'app.clock_events': { subject: [E()], actor: ['recorded_by'], category: 'time_records', erase: DEL },
  'app.timesheets': { subject: [E()], actor: ['submitted_by'], category: 'time_records', erase: DEL },
  'app.working_time_opt_outs': {
    subject: [E()],
    actor: ['recorded_by', 'ended_by'],
    category: 'time_records',
    erase: DEL,
  },
  'app.kiosk_pins': { subject: [E()], category: 'account', erase: DEL, omit: ['pin_hash'] },
  'app.worked_hours': { subject: [E()], actor: ['created_by'], category: 'time_records', erase: DEL },

  // ---- compliance -----------------------------------------------------------------------------------
  // superseded_by on rtw_checks points at the newer check, not a person; it is listed so the catalog check passes.
  'app.rtw_checks': {
    subject: [E()],
    actor: ['checked_by', 'superseded_by'],
    category: 'immigration_records',
    erase: DEL,
  },
  'app.i9_records': { subject: [E()], actor: ['created_by'], category: 'immigration_records', erase: DEL },
  'app.flsa_attestations': {
    subject: [E()],
    actor: ['attested_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.compliance_records': {
    subject: [E()],
    actor: ['recorded_by'],
    category: 'personnel_records',
    erase: DEL,
  },
  'app.pay_report_inputs': { subject: [E()], actor: ['created_by'], category: 'payroll_records', erase: DEL },
  'app.law_change_reads': { subject: [U()], category: 'account', erase: DEL },
  // Ask HR keeps a hash and the outcome of each question, never its text (ADR-0111).
  'app.ai_questions': { subject: [U()], category: 'account', erase: DEL },

  // ---- payroll handoff, payslips, IT automation and assets ---------------------------------------------
  'app.payslips': { subject: [E()], category: 'payroll_records', erase: DEL },
  'app.it_accounts': { subject: [E()], category: 'personnel_records', erase: DEL },
  'app.it_operations': { subject: [E()], category: 'personnel_records', erase: DEL },
  'app.integration_calls': { subject: [E('subject_employee_id')], category: 'personnel_records', erase: DEL },
  'app.asset_assignments': {
    subject: [E()],
    actor: ['acknowledged_by', 'created_by', 'received_by'],
    category: 'personnel_records',
    erase: { anonymise: { acknowledged_ip: null, acknowledged_user_agent: null, handover_note: null } },
  },

  // ---- reports ---------------------------------------------------------------------------------------
  'app.saved_reports': {
    subject: [U('owner_user_id')],
    category: 'accountability',
    erase: { keep: 'company report definition (no personal data); other users may share it' },
  },

  // ---- account and security -------------------------------------------------------------------------
  'app.users': {
    subject: [U('id'), E('employee_id')],
    category: 'account',
    erase: {
      anonymise: {
        email: '=erased-email',
        display_name: ERASED,
        external_id: null,
        locale: null,
        time_zone: null,
        status: 'deactivated',
        last_login_at: null,
      },
    },
  },
  'app.sessions': { subject: [U()], category: 'account', erase: DEL },
  'app.passkeys': { subject: [U()], category: 'account', erase: DEL },
  'app.password_credentials': { subject: [U()], category: 'account', erase: DEL },
  'app.totp_factors': { subject: [U()], category: 'account', erase: DEL },
  'app.magic_links': { subject: [U()], category: 'account', erase: DEL },
  'app.auth_challenges': { subject: [U()], category: 'account', erase: DEL },
  'app.ics_tokens': { subject: [U()], category: 'account', erase: DEL },
  'app.push_subscriptions': { subject: [U()], category: 'account', erase: DEL },
  'app.notifications': { subject: [U()], category: 'notifications', erase: DEL },
  'app.group_members': { subject: [U()], category: 'account', erase: DEL },
  'app.role_assignments': { subject: [U()], actor: ['created_by'], category: 'account', erase: DEL },
  'app.delegations': { subject: [U('from_user_id'), U('to_user_id')], category: 'account', erase: DEL },
  'app.subprocessor_subscriptions': { subject: [U()], category: 'account', erase: DEL },
  'app.support_grants': {
    subject: [],
    actor: ['granted_by_user_id'],
    category: 'accountability',
    erase: { keep: 'security record of support access' },
  },
  // Support cases are the customer's contract record with Thapsus: kept, and exported to the person who wrote them.
  'app.support_tickets': {
    subject: [U('requester_user_id')],
    category: 'accountability',
    erase: { keep: 'support case record; the requester appears as the erased user' },
  },
  'app.support_ticket_messages': {
    subject: [U('author_user_id')],
    category: 'accountability',
    erase: { keep: 'support case record' },
  },
  'app.support_ticket_attachments': {
    subject: [U('uploaded_by_user_id')],
    category: 'accountability',
    erase: { keep: 'support case record' },
  },

  // ---- privacy and accountability records ----------------------------------------------------------------
  'app.dsr_requests': {
    subject: [E('subject_employee_id'), U('subject_user_id')],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'record of the request, kept to demonstrate compliance' },
  },
  'app.legal_holds': {
    subject: [E()],
    actor: ['created_by', 'released_by'],
    category: 'accountability',
    erase: { keep: 'legal hold record' },
  },
  'app.dpa_acceptances': {
    subject: [],
    actor: ['accepted_by'],
    category: 'accountability',
    erase: { keep: 'evidence of the customer accepting the DPA' },
  },
  'audit.events': {
    subject: [],
    actor: ['actor_id'],
    category: 'accountability',
    erase: { keep: 'append-only audit trail (security and accountability); exported as metadata only' },
  },
  'vault.records': {
    subject: [E('subject_id')],
    actor: ['created_by'],
    category: 'personnel_records',
    erase: DEL,
  },

  // ---- actor-only references (the person acted on company records) ----------------------------------------
  'app.account_closures': {
    subject: [],
    actor: ['requested_by', 'cancelled_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.automation_rules': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.company_exports': {
    subject: [],
    actor: ['requested_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.import_batches': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.incidents': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.jobs': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'operational record' },
  },
  'app.kiosks': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.privacy_notices': {
    subject: [],
    actor: ['updated_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.retention_policies': {
    subject: [],
    actor: ['updated_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.timesheet_exports': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'payroll export record' },
  },
  'app.compliance_requirements': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.eeo_job_categories': {
    subject: [],
    actor: ['updated_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.pay_periods': {
    subject: [],
    actor: ['created_by', 'closed_by'],
    category: 'accountability',
    erase: { keep: 'company payroll calendar' },
  },
  'app.pay_period_snapshots': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: {
      keep: 'closed pay-period inputs, kept so payroll exports stay reproducible for the payroll record retention period',
    },
  },
  'app.payroll_exports': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'payroll export record' },
  },
  'app.payroll_deliveries': {
    subject: [],
    actor: ['requested_by'],
    category: 'accountability',
    erase: { keep: 'delivery log' },
  },
  'app.payroll_connectors': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.integration_credentials': {
    subject: [],
    actor: ['updated_by'],
    category: 'accountability',
    erase: { keep: 'company configuration (sealed credentials)' },
  },
  'app.integration_oauth_states': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'single-use OAuth state that expires within minutes' },
  },
  'app.payslip_batches': {
    subject: [],
    actor: ['created_by', 'published_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  'app.it_connections': {
    subject: [],
    actor: ['consented_by', 'created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.assets': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company asset register' },
  },
  'app.report_runs': {
    subject: [],
    actor: ['requested_by'],
    category: 'accountability',
    erase: { keep: 'report run log; result files expire automatically' },
  },
  'app.report_schedules': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.data_exports': {
    subject: [],
    actor: ['created_by', 'run_as_user_id'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.export_destinations': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.api_keys': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company integration credential (hash only)' },
  },
  'app.oauth_clients': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company integration credential (hash only)' },
  },
  'app.webhook_endpoints': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.audit_streams': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company configuration' },
  },
  'app.sandboxes': {
    subject: [],
    actor: ['created_by'],
    category: 'accountability',
    erase: { keep: 'company record' },
  },
  // security monitoring (ADR-0178): the workspace's copy of a detection names the person it concerns
  'app.security_alerts': {
    subject: [U('subject_user_id')],
    actor: ['acknowledged_by'],
    category: 'accountability',
    erase: { anonymise: { subject_user_id: null } },
  },
  'app.security_alert_recipients': { subject: [U()], actor: ['created_by'], category: 'account', erase: DEL },
};

/**
 * Columns that reference a person: foreign keys to app.employees / app.users, plus uuid columns
 * whose names say so. Used by the completeness test and by the exporter to find new FK links.
 */
export const PERSON_COLUMN_NAME =
  /(employee|user|subject|signer|manager|requester|assignee|actor)_id$|_by(_user_id)?$/;

export interface CatalogColumn {
  table: string;
  column: string;
  fkTo: 'app.employees' | 'app.users' | null;
}

export async function personColumns(tx: Tx): Promise<CatalogColumn[]> {
  return tx.query<CatalogColumn>(
    `WITH fk AS (
       SELECT k.conrelid, a.attname, format('%I.%I', pn.nspname, p.relname) AS target
         FROM pg_constraint k JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
         CROSS JOIN LATERAL unnest(k.conkey) x JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x
        WHERE k.contype = 'f' AND pn.nspname = 'app' AND p.relname IN ('employees', 'users') AND a.attname <> 'tenant_id')
     SELECT format('%I.%I', n.nspname, c.relname) AS "table", a.attname AS "column",
            (SELECT fk.target FROM fk WHERE fk.conrelid = c.oid AND fk.attname = a.attname LIMIT 1) AS "fkTo"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND n.nspname IN ('app', 'vault', 'audit') AND a.atttypid = 'uuid'::regtype
        AND a.attname NOT IN ('tenant_id', 'id')
        AND (a.attname ~ $1 OR EXISTS (SELECT 1 FROM fk WHERE fk.conrelid = c.oid AND fk.attname = a.attname))
      ORDER BY 1, 2`,
    [PERSON_COLUMN_NAME.source],
  );
}

/** Problems with the map against the live catalog (empty = every person reference is covered). */
export async function coverageProblems(tx: Tx): Promise<string[]> {
  const problems: string[] = [];
  const cols = await personColumns(tx);
  for (const c of cols) {
    const rule = SUBJECT_TABLES[c.table];
    if (!rule) {
      problems.push(`${c.table}.${c.column} references a person but ${c.table} is not in SUBJECT_TABLES`);
      continue;
    }
    const listed = rule.subject.some((l) => l.column === c.column) || (rule.actor ?? []).includes(c.column);
    if (!listed) problems.push(`${c.table}.${c.column} is not listed as a subject or actor column`);
    if (
      c.fkTo &&
      rule.subject.some(
        (l) => l.column === c.column && `app.${l.kind === 'employee' ? 'employees' : 'users'}` !== c.fkTo,
      )
    )
      problems.push(`${c.table}.${c.column} links to ${c.fkTo} but is mapped to another kind`);
  }
  const existing = new Set(
    (
      await tx.query<{ t: string }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('app', 'vault', 'audit')`,
      )
    ).map((r) => r.t),
  );
  for (const t of Object.keys(SUBJECT_TABLES))
    if (!existing.has(t)) problems.push(`${t} is in SUBJECT_TABLES but no longer exists`);
  return problems;
}
