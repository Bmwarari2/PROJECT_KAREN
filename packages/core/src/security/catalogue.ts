import { compareDates, type CivilDate } from '../time';
import { knownSignal } from './signals';

/**
 * Detection rule catalogue (ADR-0177): versioned, effective-dated data in the repository, like the
 * jurisdiction packs. Each rule names its signal types, its logic, a severity, a MITRE ATT&CK technique,
 * a dedupe window, any automated containment, whether the customer's admins see it, a test fixture (events
 * that must fire it once, and a near miss that must not) and its tuning history. A change to a rule is a new
 * version with a new `effectiveFrom`; the old version stays in the file with an `effectiveTo`.
 *
 * Display names and summaries are in the message catalogues (`backoffice.security.rules.<id>`); the tuning
 * notes here are the analysts' record.
 */
export const CATALOGUE_VERSION = 1;

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
export type Area =
  | 'credential'
  | 'takeover'
  | 'privilege'
  | 'exfiltration'
  | 'probing'
  | 'staff'
  | 'deception'
  | 'ai'
  | 'cloud';
/** Fields a rule can group events by; each maps to one column of security.events. */
export type GroupField = 'ip' | 'tenant' | 'actor' | 'staff' | 'account' | 'route';
export type ContainmentKind = 'block_ip' | 'end_sessions' | 'suspend_api_key' | 'freeze_staff';

export interface Where {
  /** detail->>key equals the value (as text). */
  detail?: Record<string, string | boolean>;
  /** The route pattern starts with one of these. */
  routePrefix?: string[];
  /** The event happened outside [from, to) hours UTC. */
  outsideHoursUtc?: [number, number];
}
export interface ThresholdLogic {
  kind: 'threshold';
  types: string[];
  groupBy: GroupField[];
  windowMinutes: number;
  minEvents: number;
  distinct?: { field: Exclude<GroupField, 'route'> | 'route'; min: number };
  where?: Where;
}
export interface SequenceLogic {
  kind: 'sequence';
  before: { types: string[]; minEvents: number };
  then: { types: string[] };
  groupBy: GroupField[];
  windowMinutes: number;
}
export interface RatioLogic {
  kind: 'ratio';
  failures: string[];
  successes: string[];
  groupBy: GroupField[];
  windowMinutes: number;
  minFailures: number;
  /** failures / (failures + successes), in basis points. */
  minRatioBasisPoints: number;
}
export type RuleLogic = ThresholdLogic | SequenceLogic | RatioLogic;

/**
 * A fixture event, `minutesAgo` before the evaluation time. Addresses, accounts, workspaces, people and staff
 * are fixture names (`ip-one`, `A`, `U1`, `S1`); the test harness turns each into a stable fictional id.
 */
export interface FixtureEvent {
  minutesAgo: number;
  type: string;
  ip?: string;
  tenant?: string;
  actor?: string;
  staff?: string;
  account?: string;
  route?: string;
  detail?: Record<string, string | boolean | number>;
  /** Repeat this event n times, one second apart. */
  repeat?: number;
}

export interface DetectionRule {
  id: string;
  version: number;
  effectiveFrom: CivilDate;
  effectiveTo?: CivilDate;
  status: 'active' | 'planned';
  area: Area;
  severity: Severity;
  mitre: { id: string; name: string };
  logic?: RuleLogic;
  /** Detections of this rule within this many minutes of the last one join the same detection and incident. */
  dedupeMinutes: number;
  /** Which group field identifies the incident a detection rolls up into (default: the first groupBy field). */
  incidentBy?: GroupField | 'rule';
  containment?: Array<{ kind: ContainmentKind; minutes?: number }>;
  /** The customer's admins see it in their Security centre (and are emailed) when it concerns their workspace. */
  customerVisible: boolean;
  /** Where the signal comes from when it is not built yet (planned rules). */
  needs?: string;
  fixture?: { fires: FixtureEvent[]; nearMiss: FixtureEvent[] };
  tuning: Array<{ on: CivilDate; note: string }>;
}

const SIGN_IN = ['/v1/auth/', '/v1/backoffice/auth/', '/v1/oauth/token'];
const EXPORTS = [
  'audit.export.created',
  'audit.export.run_requested',
  'audit.privacy.company_export_requested',
  'audit.privacy.company_export_downloaded',
  'audit.report.downloaded',
  'audit.payroll.export_downloaded',
  'audit.document.downloaded',
  'audit.payslip.downloaded',
];
const FIRST = '2026-10-24';
const created = (note: string) => [{ on: FIRST, note }];

export const DETECTION_RULES: DetectionRule[] = [
  // ---- credential attacks -------------------------------------------------------------------------------
  {
    id: 'THR-CRED-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'credential',
    severity: 'high',
    mitre: { id: 'T1110.003', name: 'Brute Force: Password Spraying' },
    logic: {
      kind: 'threshold',
      types: ['authn.failed'],
      groupBy: ['ip'],
      windowMinutes: 10,
      minEvents: 20,
      where: { routePrefix: SIGN_IN },
    },
    dedupeMinutes: 60,
    containment: [{ kind: 'block_ip', minutes: 60 }],
    customerVisible: false,
    fixture: {
      fires: [{ minutesAgo: 5, type: 'authn.failed', ip: 'ip-one', route: '/v1/auth/login', repeat: 20 }],
      nearMiss: [{ minutesAgo: 5, type: 'authn.failed', ip: 'ip-one', route: '/v1/auth/login', repeat: 19 }],
    },
    tuning: created(
      'Twenty refused sign-ins from one address in ten minutes; an office behind one address rarely fails twenty times. Blocks the address for an hour.',
    ),
  },
  {
    id: 'THR-CRED-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'credential',
    severity: 'high',
    mitre: { id: 'T1110.004', name: 'Brute Force: Credential Stuffing' },
    logic: {
      kind: 'threshold',
      types: ['auth.login_failed'],
      groupBy: ['ip'],
      windowMinutes: 15,
      minEvents: 10,
      distinct: { field: 'account', min: 10 },
    },
    dedupeMinutes: 120,
    containment: [{ kind: 'block_ip', minutes: 120 }],
    customerVisible: false,
    fixture: {
      fires: Array.from({ length: 10 }, (_, i) => ({
        minutesAgo: 3,
        type: 'auth.login_failed',
        ip: 'ip-two',
        account: `acct-${i}`,
      })),
      nearMiss: Array.from({ length: 12 }, (_, i) => ({
        minutesAgo: 3,
        type: 'auth.login_failed',
        ip: 'ip-two',
        account: `acct-${i % 9}`,
      })),
    },
    tuning: created(
      'Failures for ten different accounts from one address in fifteen minutes. Needs the keyed account hash of the identity events.',
    ),
  },
  {
    id: 'THR-CRED-003',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'credential',
    severity: 'medium',
    mitre: { id: 'T1110', name: 'Brute Force' },
    logic: {
      kind: 'ratio',
      failures: ['audit.auth.login_failed'],
      successes: ['audit.auth.login'],
      groupBy: ['tenant'],
      windowMinutes: 15,
      minFailures: 25,
      minRatioBasisPoints: 8000,
    },
    dedupeMinutes: 120,
    customerVisible: true,
    fixture: {
      fires: [
        { minutesAgo: 6, type: 'audit.auth.login_failed', tenant: 'A', actor: 'U1', repeat: 25 },
        { minutesAgo: 6, type: 'audit.auth.login', tenant: 'A', actor: 'U2', repeat: 2 },
      ],
      nearMiss: [
        { minutesAgo: 6, type: 'audit.auth.login_failed', tenant: 'A', actor: 'U1', repeat: 25 },
        { minutesAgo: 6, type: 'audit.auth.login', tenant: 'A', actor: 'U2', repeat: 10 },
      ],
    },
    tuning: created(
      "At least 25 failed sign-ins in a workspace in fifteen minutes, and at least 80% of its sign-ins failing. A busy workspace's normal typos stay under the ratio.",
    ),
  },
  {
    id: 'THR-CRED-004',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'credential',
    severity: 'high',
    mitre: { id: 'T1110.001', name: 'Brute Force: Password Guessing' },
    logic: {
      kind: 'sequence',
      before: { types: ['audit.auth.login_failed'], minEvents: 5 },
      then: { types: ['audit.auth.login'] },
      groupBy: ['tenant', 'actor'],
      windowMinutes: 30,
    },
    dedupeMinutes: 60,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [
        { minutesAgo: 10, type: 'audit.auth.login_failed', tenant: 'A', actor: 'U1', repeat: 5 },
        { minutesAgo: 2, type: 'audit.auth.login', tenant: 'A', actor: 'U1' },
      ],
      nearMiss: [
        { minutesAgo: 10, type: 'audit.auth.login_failed', tenant: 'A', actor: 'U1', repeat: 4 },
        { minutesAgo: 2, type: 'audit.auth.login', tenant: 'A', actor: 'U1' },
        { minutesAgo: 10, type: 'audit.auth.login_failed', tenant: 'A', actor: 'U2', repeat: 5 },
      ],
    },
    tuning: created(
      'A successful sign-in after five failures for the same person within thirty minutes: the guess may have worked. Suggests ending their sessions.',
    ),
  },
  // ---- account takeover ----------------------------------------------------------------------------------
  {
    id: 'THR-ATO-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'takeover',
    severity: 'medium',
    mitre: { id: 'T1556.006', name: 'Modify Authentication Process: Multi-Factor Authentication' },
    logic: {
      kind: 'threshold',
      types: ['audit.auth.mfa_reset'],
      groupBy: ['tenant'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 60,
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 1, type: 'audit.auth.mfa_reset', tenant: 'A', actor: 'U1' }],
      nearMiss: [{ minutesAgo: 90, type: 'audit.auth.mfa_reset', tenant: 'A', actor: 'U1' }],
    },
    tuning: created("Every reset of someone's second factor: the usual first step of a help-desk takeover."),
  },
  {
    id: 'THR-ATO-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'takeover',
    severity: 'medium',
    mitre: { id: 'T1550.004', name: 'Use Alternate Authentication Material: Web Session Cookie' },
    logic: {
      kind: 'threshold',
      types: ['auth.session_network_changed'],
      groupBy: ['tenant', 'actor'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 240,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 1, type: 'auth.session_network_changed', tenant: 'A', actor: 'U1' }],
      nearMiss: [{ minutesAgo: 1, type: 'authz.denied', tenant: 'A', actor: 'U1' }],
    },
    tuning: created(
      'A session used from a second network (needs the network signal of the identity events; cells without it never fire).',
    ),
  },
  {
    id: 'THR-ATO-003',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'takeover',
    severity: 'high',
    mitre: { id: 'T1098.005', name: 'Account Manipulation: Device Registration' },
    logic: {
      kind: 'sequence',
      before: {
        types: ['audit.auth.password_reset_completed', 'audit.auth.password_reset'],
        minEvents: 1,
      },
      then: { types: ['audit.auth.passkey_registered', 'audit.auth.mfa.totp_enroll_started'] },
      groupBy: ['tenant', 'actor'],
      windowMinutes: 60,
    },
    dedupeMinutes: 240,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [
        { minutesAgo: 20, type: 'audit.auth.password_reset_completed', tenant: 'A', actor: 'U1' },
        { minutesAgo: 5, type: 'audit.auth.passkey_registered', tenant: 'A', actor: 'U1' },
      ],
      nearMiss: [
        { minutesAgo: 20, type: 'audit.auth.password_reset_completed', tenant: 'A', actor: 'U1' },
        { minutesAgo: 5, type: 'audit.auth.passkey_registered', tenant: 'A', actor: 'U2' },
      ],
    },
    tuning: created('A new passkey or authenticator within an hour of a password reset for the same person.'),
  },
  {
    id: 'THR-ATO-004',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'takeover',
    severity: 'high',
    mitre: { id: 'T1606.002', name: 'Forge Web Credentials: SAML Tokens' },
    logic: {
      kind: 'threshold',
      types: ['auth.sso_subject_mismatch'],
      groupBy: ['tenant'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 240,
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 2, type: 'auth.sso_subject_mismatch', tenant: 'A' }],
      nearMiss: [{ minutesAgo: 2, type: 'auth.sso_identity_bound', tenant: 'A' }],
    },
    tuning: created(
      'An identity provider asserted another subject for a person already linked to one: a misconfigured or hostile connection.',
    ),
  },
  // ---- privilege changes -----------------------------------------------------------------------------------
  {
    id: 'THR-PRIV-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'privilege',
    severity: 'medium',
    mitre: { id: 'T1098', name: 'Account Manipulation' },
    logic: {
      kind: 'threshold',
      types: ['audit.role.assigned'],
      groupBy: ['tenant'],
      windowMinutes: 60,
      minEvents: 1,
      where: { detail: { isAdmin: true } },
    },
    dedupeMinutes: 60,
    customerVisible: true,
    fixture: {
      fires: [
        { minutesAgo: 1, type: 'audit.role.assigned', tenant: 'A', actor: 'U1', detail: { isAdmin: true } },
      ],
      nearMiss: [
        { minutesAgo: 1, type: 'audit.role.assigned', tenant: 'A', actor: 'U1', detail: { isAdmin: false } },
      ],
    },
    tuning: created('Any admin-grade role handed out (MFA becomes mandatory for the person).'),
  },
  {
    id: 'THR-PRIV-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'privilege',
    severity: 'high',
    mitre: { id: 'T1098.003', name: 'Account Manipulation: Additional Cloud Roles' },
    logic: {
      kind: 'threshold',
      types: ['audit.role.assigned'],
      groupBy: ['tenant'],
      windowMinutes: 60,
      minEvents: 1,
      where: { detail: { role: 'owner' } },
    },
    dedupeMinutes: 60,
    customerVisible: true,
    fixture: {
      fires: [
        { minutesAgo: 1, type: 'audit.role.assigned', tenant: 'A', actor: 'U1', detail: { role: 'owner' } },
      ],
      nearMiss: [
        {
          minutesAgo: 1,
          type: 'audit.role.assigned',
          tenant: 'A',
          actor: 'U1',
          detail: { role: 'hr_admin' },
        },
      ],
    },
    tuning: created('A new owner: the one role that holds every permission.'),
  },
  {
    id: 'THR-PRIV-003',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'privilege',
    severity: 'medium',
    mitre: { id: 'T1098.001', name: 'Account Manipulation: Additional Cloud Credentials' },
    logic: {
      kind: 'threshold',
      types: [
        'audit.api_key.created',
        'audit.oauth_client.created',
        'audit.scim.token_created',
        'audit.sso.connection_created',
        'audit.sso.connection_updated',
        'audit.sso.connection_deleted',
        'audit.settings.security_updated',
      ],
      groupBy: ['tenant'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 60,
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 1, type: 'audit.api_key.created', tenant: 'A', actor: 'U1' }],
      nearMiss: [{ minutesAgo: 1, type: 'audit.user.invited', tenant: 'A', actor: 'U1' }],
    },
    tuning: created(
      'New machine credentials (API key, OAuth client, SCIM token) or a change to SSO or the sign-in policy.',
    ),
  },
  // ---- exfiltration ---------------------------------------------------------------------------------------
  {
    id: 'THR-EXFIL-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'exfiltration',
    severity: 'high',
    mitre: { id: 'T1567', name: 'Exfiltration Over Web Service' },
    logic: {
      kind: 'threshold',
      types: EXPORTS,
      groupBy: ['tenant', 'actor'],
      windowMinutes: 60,
      minEvents: 30,
    },
    dedupeMinutes: 120,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 30, type: 'audit.document.downloaded', tenant: 'A', actor: 'U1', repeat: 30 }],
      nearMiss: [
        { minutesAgo: 30, type: 'audit.document.downloaded', tenant: 'A', actor: 'U1', repeat: 15 },
        { minutesAgo: 30, type: 'audit.document.downloaded', tenant: 'A', actor: 'U2', repeat: 15 },
      ],
    },
    tuning: created(
      'Thirty exports, report or payroll downloads, documents or payslips by one person in an hour. A per-person baseline replaces the fixed threshold once there is a month of history.',
    ),
  },
  {
    id: 'THR-EXFIL-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'exfiltration',
    severity: 'high',
    mitre: { id: 'T1530', name: 'Data from Cloud Storage' },
    logic: {
      kind: 'threshold',
      types: ['audit.vault.read'],
      groupBy: ['tenant', 'actor'],
      windowMinutes: 10,
      minEvents: 25,
    },
    dedupeMinutes: 120,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 4, type: 'audit.vault.read', tenant: 'A', actor: 'U1', repeat: 25 }],
      nearMiss: [{ minutesAgo: 4, type: 'audit.vault.read', tenant: 'A', actor: 'U1', repeat: 24 }],
    },
    tuning: created(
      'Twenty-five reads of special-category records (health, immigration…) by one person in ten minutes.',
    ),
  },
  // ---- probing ---------------------------------------------------------------------------------------------
  {
    id: 'THR-PROBE-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'probing',
    severity: 'high',
    mitre: { id: 'T1190', name: 'Exploit Public-Facing Application' },
    logic: { kind: 'threshold', types: ['authz.denied'], groupBy: ['ip'], windowMinutes: 10, minEvents: 30 },
    dedupeMinutes: 60,
    containment: [{ kind: 'block_ip', minutes: 60 }],
    customerVisible: false,
    fixture: {
      fires: [
        { minutesAgo: 2, type: 'authz.denied', ip: 'ip-probe', route: '/v1/employees/:id', repeat: 30 },
      ],
      nearMiss: [
        { minutesAgo: 2, type: 'authz.denied', ip: 'ip-probe', route: '/v1/employees/:id', repeat: 29 },
      ],
    },
    tuning: created(
      "Thirty refusals for one address in ten minutes: walking other people's or other workspaces' ids.",
    ),
  },
  {
    id: 'THR-PROBE-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'probing',
    severity: 'medium',
    mitre: { id: 'T1595.003', name: 'Active Scanning: Wordlist Scanning' },
    logic: {
      kind: 'threshold',
      types: ['route.not_found', 'http.not_found'],
      groupBy: ['ip'],
      windowMinutes: 10,
      minEvents: 40,
    },
    dedupeMinutes: 60,
    containment: [{ kind: 'block_ip', minutes: 30 }],
    customerVisible: false,
    fixture: {
      fires: [
        { minutesAgo: 2, type: 'route.not_found', ip: 'ip-scan', repeat: 30 },
        { minutesAgo: 2, type: 'http.not_found', ip: 'ip-scan', route: '/v1/documents/:id', repeat: 10 },
      ],
      nearMiss: [{ minutesAgo: 2, type: 'route.not_found', ip: 'ip-scan', repeat: 39 }],
    },
    tuning: created(
      'Forty not-found answers for one address in ten minutes: a scanner or sequential id probing.',
    ),
  },
  {
    id: 'THR-PROBE-003',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'probing',
    severity: 'medium',
    mitre: { id: 'T1595.002', name: 'Active Scanning: Vulnerability Scanning' },
    logic: {
      kind: 'threshold',
      types: ['input.rejected'],
      groupBy: ['ip'],
      windowMinutes: 10,
      minEvents: 50,
    },
    dedupeMinutes: 60,
    customerVisible: false,
    fixture: {
      fires: [
        { minutesAgo: 2, type: 'input.rejected', ip: 'ip-fuzz', route: '/v1/leave/requests', repeat: 50 },
      ],
      nearMiss: [
        { minutesAgo: 2, type: 'input.rejected', ip: 'ip-fuzz', route: '/v1/leave/requests', repeat: 49 },
      ],
    },
    tuning: created(
      'Fifty rejected request bodies from one address in ten minutes: a fuzzer. Not blocked automatically (a broken integration looks the same).',
    ),
  },
  // ---- Thapsus staff -----------------------------------------------------------------------------------------
  {
    id: 'THR-STAFF-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'staff',
    severity: 'high',
    mitre: { id: 'T1110', name: 'Brute Force' },
    logic: {
      kind: 'threshold',
      types: [
        'staffaudit.staff.login_failed',
        'staffaudit.staff.mfa_failed',
        'staffaudit.staff.reauth_failed',
      ],
      groupBy: ['staff'],
      windowMinutes: 15,
      minEvents: 5,
    },
    dedupeMinutes: 60,
    containment: [{ kind: 'freeze_staff' }],
    customerVisible: false,
    fixture: {
      fires: [{ minutesAgo: 3, type: 'staffaudit.staff.login_failed', staff: 'S1', repeat: 5 }],
      nearMiss: [
        { minutesAgo: 3, type: 'staffaudit.staff.login_failed', staff: 'S1', repeat: 4 },
        { minutesAgo: 3, type: 'staffaudit.staff.mfa_failed', staff: 'S2', repeat: 4 },
      ],
    },
    tuning: created(
      'Five failed sign-in, second-factor or re-authentication steps for one staff account in fifteen minutes. Freezes the account; unfreezing needs two people. Never freezes the last active super admin.',
    ),
  },
  {
    id: 'THR-STAFF-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'staff',
    severity: 'high',
    mitre: { id: 'T1213', name: 'Data from Information Repositories' },
    logic: {
      kind: 'threshold',
      types: ['staffaudit.tenant.viewed', 'staffaudit.support.ticket_viewed'],
      groupBy: ['staff'],
      windowMinutes: 60,
      minEvents: 15,
      distinct: { field: 'tenant', min: 15 },
    },
    dedupeMinutes: 240,
    customerVisible: false,
    fixture: {
      fires: Array.from({ length: 15 }, (_, i) => ({
        minutesAgo: 20,
        type: 'staffaudit.tenant.viewed',
        staff: 'S1',
        tenant: `T${i}`,
      })),
      nearMiss: Array.from({ length: 20 }, (_, i) => ({
        minutesAgo: 20,
        type: 'staffaudit.tenant.viewed',
        staff: 'S1',
        tenant: `T${i % 14}`,
      })),
    },
    tuning: created(
      'One staff member opening fifteen different workspaces in an hour (support works ticket by ticket).',
    ),
  },
  // ---- deception -----------------------------------------------------------------------------------------------
  {
    id: 'THR-DECEPT-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'deception',
    severity: 'critical',
    mitre: { id: 'T1552.001', name: 'Unsecured Credentials: Credentials In Files' },
    logic: {
      kind: 'threshold',
      types: ['honeytoken.api_key', 'honeytoken.object'],
      groupBy: ['ip'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 1440,
    containment: [{ kind: 'block_ip', minutes: 1440 }],
    customerVisible: false,
    fixture: {
      fires: [{ minutesAgo: 1, type: 'honeytoken.api_key', ip: 'ip-honey' }],
      nearMiss: [{ minutesAgo: 1, type: 'authn.failed', ip: 'ip-honey', route: '/v1/employees' }],
    },
    tuning: created(
      'The decoy API key from the documentation, or a decoy object key, was used: nobody has a reason to. Blocks the address for a day.',
    ),
  },
  {
    id: 'THR-DECEPT-002',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'deception',
    severity: 'high',
    mitre: { id: 'T1595.003', name: 'Active Scanning: Wordlist Scanning' },
    logic: {
      kind: 'threshold',
      types: ['honeytoken.endpoint'],
      groupBy: ['ip'],
      windowMinutes: 60,
      minEvents: 1,
    },
    dedupeMinutes: 1440,
    containment: [{ kind: 'block_ip', minutes: 60 }],
    customerVisible: false,
    fixture: {
      fires: [{ minutesAgo: 1, type: 'honeytoken.endpoint', ip: 'ip-scan2', route: '/.env' }],
      nearMiss: [{ minutesAgo: 1, type: 'route.not_found', ip: 'ip-scan2' }],
    },
    tuning: created(
      'A honey endpoint (/.env, /wp-login.php, /v1/admin/export-all…) was requested. High rather than critical: internet scanners touch these daily; one incident per address per day keeps the alerts bounded.',
    ),
  },
  // ---- AI ------------------------------------------------------------------------------------------------------
  {
    id: 'THR-AI-001',
    version: 1,
    effectiveFrom: FIRST,
    status: 'active',
    area: 'ai',
    severity: 'medium',
    mitre: { id: 'T1496', name: 'Resource Hijacking' },
    logic: {
      kind: 'threshold',
      types: ['audit.ai.question_asked'],
      groupBy: ['tenant', 'actor'],
      windowMinutes: 60,
      minEvents: 60,
    },
    dedupeMinutes: 240,
    incidentBy: 'actor',
    customerVisible: true,
    fixture: {
      fires: [{ minutesAgo: 30, type: 'audit.ai.question_asked', tenant: 'A', actor: 'U1', repeat: 60 }],
      nearMiss: [{ minutesAgo: 30, type: 'audit.ai.question_asked', tenant: 'A', actor: 'U1', repeat: 59 }],
    },
    tuning: created(
      'Sixty Ask HR questions by one person in an hour: automated use or a jailbreak attempt (the per-user caps refuse beyond them).',
    ),
  },
  // ---- planned (P1: needs cloud services or owner steps; listed, not built) --------------------------------------
  ...(
    [
      [
        'THR-CLOUD-001',
        'high',
        'T1078.004',
        'Valid Accounts: Cloud Accounts',
        'GuardDuty high or critical finding',
      ],
      [
        'THR-CLOUD-002',
        'high',
        'T1562.008',
        'Impair Defenses: Disable or Modify Cloud Logs',
        'Security Hub critical control failed, or a trail or detector stopped',
      ],
      ['THR-CLOUD-003', 'critical', 'T1078.004', 'Valid Accounts: Cloud Accounts', 'CloudTrail root sign-in'],
      [
        'THR-CLOUD-004',
        'high',
        'T1098.001',
        'Account Manipulation: Additional Cloud Credentials',
        'CloudTrail IAM or KMS key-policy change',
      ],
      [
        'THR-CLOUD-005',
        'high',
        'T1562.007',
        'Impair Defenses: Disable or Modify Cloud Firewall',
        'AWS Config: a security group opened to the internet',
      ],
      [
        'THR-ATO-005',
        'high',
        'T1078',
        'Valid Accounts',
        'Risk-based sign-in signals (new country or ASN, impossible travel)',
      ],
      [
        'THR-STAFF-003',
        'critical',
        'T1078.004',
        'Valid Accounts: Cloud Accounts',
        'Break-glass account use (sealed accounts not created yet)',
      ],
      [
        'THR-AI-002',
        'high',
        'T1059',
        'Command and Scripting Interpreter',
        'Prompt-injection canary echoed (canaries not planted yet)',
      ],
    ] as const
  ).map(([id, severity, mitre, name, needs]): DetectionRule => ({
    id,
    version: 1,
    effectiveFrom: FIRST,
    status: 'planned',
    area: id.startsWith('THR-CLOUD')
      ? 'cloud'
      : id.startsWith('THR-ATO')
        ? 'takeover'
        : id.startsWith('THR-AI')
          ? 'ai'
          : 'staff',
    severity,
    mitre: { id: mitre, name },
    dedupeMinutes: 60,
    customerVisible: false,
    needs,
    tuning: created('Planned (P1): listed so the catalogue shows the gap; not evaluated.'),
  })),
];

/** The version of each rule in force on a date (half-open [effectiveFrom, effectiveTo)). */
export function rulesInForce(on: CivilDate, rules = DETECTION_RULES): DetectionRule[] {
  return rules.filter(
    (r) => compareDates(r.effectiveFrom, on) <= 0 && (!r.effectiveTo || compareDates(on, r.effectiveTo) < 0),
  );
}

export function ruleById(id: string, on: CivilDate, rules = DETECTION_RULES): DetectionRule | undefined {
  return rulesInForce(on, rules).find((r) => r.id === id);
}

export function logicTypes(l: RuleLogic): string[] {
  return l.kind === 'threshold'
    ? l.types
    : l.kind === 'sequence'
      ? [...l.before.types, ...l.then.types]
      : [...l.failures, ...l.successes];
}

/** Problems with the catalogue (the unit test fails on any). */
export function catalogueProblems(rules = DETECTION_RULES): string[] {
  const out: string[] = [];
  const seen = new Map<string, DetectionRule[]>();
  for (const r of rules) {
    if (!/^THR-[A-Z]+-\d{3}$/.test(r.id)) out.push(`${r.id}: bad id`);
    if (!/^T\d{4}(\.\d{3})?$/.test(r.mitre.id)) out.push(`${r.id}: bad MITRE ATT&CK id ${r.mitre.id}`);
    if (!r.tuning.length) out.push(`${r.id}: no tuning note`);
    if (r.effectiveTo && compareDates(r.effectiveTo, r.effectiveFrom) <= 0)
      out.push(`${r.id}: empty validity`);
    seen.set(r.id, [...(seen.get(r.id) ?? []), r]);
    if (r.status === 'active') {
      if (!r.logic) out.push(`${r.id}: active without logic`);
      if (!r.fixture?.fires.length || !r.fixture.nearMiss.length)
        out.push(`${r.id}: active without a fixture`);
      for (const t of r.logic ? logicTypes(r.logic) : [])
        if (!knownSignal(t)) out.push(`${r.id}: unknown signal ${t}`);
      for (const e of [...(r.fixture?.fires ?? []), ...(r.fixture?.nearMiss ?? [])])
        if (!knownSignal(e.type)) out.push(`${r.id}: fixture uses unknown signal ${e.type}`);
      if (r.logic && r.logic.windowMinutes > 1440) out.push(`${r.id}: window over a day`);
      if (r.containment?.some((c) => c.kind === 'block_ip') && !r.logic?.groupBy.includes('ip'))
        out.push(`${r.id}: blocks an address but does not group by it`);
      if (r.containment?.some((c) => c.kind === 'freeze_staff') && !r.logic?.groupBy.includes('staff'))
        out.push(`${r.id}: freezes staff but does not group by staff`);
    } else if (!r.needs) out.push(`${r.id}: planned without saying what it needs`);
  }
  for (const [id, versions] of seen) {
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    sorted.forEach((v, i) => {
      if (v.version !== i + 1) out.push(`${id}: versions must count from 1`);
      const next = sorted[i + 1];
      if (next && (!v.effectiveTo || compareDates(v.effectiveTo, next.effectiveFrom) !== 0))
        out.push(`${id}: version ${v.version} must end when version ${next.version} starts`);
    });
  }
  return out;
}
