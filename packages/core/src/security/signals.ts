/**
 * The security signal contract (ADR-0177): every event type the detection pipeline stores and the rules
 * may reference, with where it comes from. One module, so producers and rules agree on the names.
 *
 *  - request: the API's response hook (status classes of refused requests), stored with a keyed hash of
 *    the client address and the route pattern, never the URL.
 *  - auth: authentication, session and staff events emitted by `apps/api/src/lib/security-events.ts`
 *    (`emitSecurityEvent`, the identity half of the hardening plan). Until that branch is merged they have
 *    no producer here; the pipeline subscribes with `onSecurityEvent` once it is (see the MERGE NOTE in
 *    apps/api/src/modules/security/signals.ts).
 *  - audit: watched actions of the customer audit log, copied by the `audit_events_security_signals`
 *    trigger (migration 0027) as `audit.<action>` with codes and counts only.
 *  - staff: watched actions of the staff audit trail, copied as `staffaudit.<action>`.
 *  - honeytoken: a decoy was touched.
 */
export type SignalSource = 'request' | 'auth' | 'audit' | 'staff' | 'honeytoken' | 'pipeline';

export const REQUEST_SIGNALS = {
  'authn.failed': 'A sign-in or credential route answered 401',
  'authz.denied': 'A route refused the caller (403)',
  'input.rejected': 'A request failed validation (400 or 422)',
  'antiautomation.limited': 'A throttle refused the request (429)',
  'antiautomation.locked': 'A locked account was refused (423)',
  'http.not_found': 'A known route did not find the record (404)',
  'route.not_found': 'No route matched the path (404)',
  'ip.blocked': 'A request from a contained address was refused',
} as const;

/** Event names of the identity work (security-events.ts); kept in step with its SecurityEventType. */
export const AUTH_SIGNALS = {
  'auth.login_failed': 'Failed sign-in (with keyed hashes of the address and the submitted account)',
  'auth.lockout': 'An account was locked after repeated failures',
  'auth.throttled': 'A sign-in budget refused the attempt',
  'auth.mfa_failed': 'A second-factor check failed',
  'auth.mfa_reset': "An admin reset a person's second factor",
  'auth.password_reset_requested': 'A password reset was requested',
  'auth.password_reset_completed': 'A password was reset with an emailed link',
  'auth.password_set_after_email_link': 'A password was set after an email sign-in link',
  'auth.sso_identity_bound': 'An SSO identity was linked to a person',
  'auth.sso_subject_mismatch': 'An SSO sign-in arrived with another subject for a linked person',
  'auth.sso_identity_unlinked': 'An SSO identity link was removed',
  'auth.session_network_changed': 'A session was used from another network',
  'staff.login': 'Staff signed in',
  'staff.login_failed': 'A staff sign-in failed',
  'staff.enrolment_issued': 'A staff enrolment link was issued',
  'staff.enrolled': 'A staff member enrolled a key',
  'staff.reauth_failed': 'A staff re-authentication failed',
  'staff.elevation_requested': 'Staff asked for just-in-time elevation',
  'staff.elevation_approved': 'An elevation was approved',
  'staff.elevation_denied': 'An elevation was denied',
  'staff.elevation_revoked': 'An elevation was revoked',
  'staff.elevation_missing': 'Staff reached a route without the elevation it needs',
} as const;

export const HONEYTOKEN_SIGNALS = {
  'honeytoken.api_key': 'The decoy API key was presented',
  'honeytoken.endpoint': 'A honey endpoint was requested',
  'honeytoken.object': 'A decoy object key was requested',
} as const;

/** Customer audit actions the trigger copies (migration 0027 lists the same names). */
export const WATCHED_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.mfa_reset',
  'auth.passkey_registered',
  'auth.mfa.totp_enroll_started',
  'auth.password_reset',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.all_sessions_ended',
  'role.assigned',
  'role.created',
  'role.updated',
  'role.revoked',
  'role.deleted',
  'user.invited',
  'api_key.created',
  'oauth_client.created',
  'scim.token_created',
  'sso.connection_created',
  'sso.connection_updated',
  'sso.connection_deleted',
  'settings.security_updated',
  'support.grant_created',
  'domain.added',
  'webhook.created',
  'audit_stream.created',
  'export.destination_created',
  'export.created',
  'export.run_requested',
  'privacy.company_export_requested',
  'privacy.company_export_downloaded',
  'report.downloaded',
  'report.run_requested',
  'payroll.export_downloaded',
  'document.downloaded',
  'payslip.downloaded',
  'audit.exported',
  'vault.read',
  'vault.read_denied',
  'ai.question_asked',
] as const;

/** Staff audit actions the trigger copies: every `staff.*` action plus these. */
export const WATCHED_STAFF_ACTIONS = [
  'staff.login',
  'staff.login_failed',
  'staff.mfa_failed',
  'staff.reauth_failed',
  'tenant.viewed',
  'support.ticket_viewed',
  'support.attachment_viewed',
  'staff_audit.exported',
] as const;

/** Every signal type a rule may name. */
export function knownSignal(type: string): boolean {
  return (
    type in REQUEST_SIGNALS ||
    type in AUTH_SIGNALS ||
    type in HONEYTOKEN_SIGNALS ||
    (type.startsWith('audit.') && (WATCHED_AUDIT_ACTIONS as readonly string[]).includes(type.slice(6))) ||
    (type.startsWith('staffaudit.') && (WATCHED_STAFF_ACTIONS as readonly string[]).includes(type.slice(11)))
  );
}

export function signalSource(type: string): SignalSource | undefined {
  if (type in REQUEST_SIGNALS) return 'request';
  if (type in AUTH_SIGNALS) return 'auth';
  if (type in HONEYTOKEN_SIGNALS) return 'honeytoken';
  if (type.startsWith('audit.')) return 'audit';
  if (type.startsWith('staffaudit.')) return 'staff';
  return undefined;
}
