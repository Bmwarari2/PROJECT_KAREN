import { FEATURE_FLAGS, type FeatureKey } from './features';
import { actionMatches } from './permissions';

/**
 * The permission map (ADR-0188): every page, settings section, navigation item and UI action names the
 * capability it needs, and every capability names its permissions. The web app reads it to decide what
 * to show (navigation, the settings index, search, buttons and read-only pages); the API reads it for
 * the routes those actions call (`config.capability`, enforced before the handler and published as
 * `x-capability` / `x-permission` in the OpenAPI document). Tests compare the two sides, so a button
 * cannot need less than the route it calls.
 *
 * The API still enforces each permission with its scope (own team, entity…); a capability only says
 * which permissions someone must hold somewhere.
 */
export interface Requirement {
  /** Any one of these permissions (wildcard grants such as `settings.*` count). */
  readonly any?: readonly string[];
  /** Every one of these permissions. */
  readonly all?: readonly string[];
  /** None of these (shown only to people without them; the API does not enforce this part). */
  readonly none?: readonly string[];
  /**
   * The permissions must be held company-wide, by a role assigned for the whole workspace: settings and
   * lists the API checks without a person (or other record) to scope them by. A country or entity HR
   * admin holds privacy.read for their entity only, so the workspace's privacy pages are not theirs.
   */
  readonly workspace?: boolean;
  /** The viewer has an employee record (self-service). */
  readonly employee?: boolean;
  /** The workspace feature flag is on (features.ts). */
  readonly feature?: FeatureKey;
  /** Ask HR is available to the viewer (the flag, the region and the customer's opt-in, from the API). */
  readonly askHr?: boolean;
  /** Not offered inside a sandbox workspace. */
  readonly notInSandbox?: boolean;
  /**
   * Permissions the API route also consults without requiring them (an owner-or-manage rule such as
   * "your own saved report, or any with reports.manage"). Listed so the route check can tell them from a
   * stricter permission than the capability declares.
   */
  readonly alsoChecks?: readonly string[];
}

const anyOf = (...any: string[]): Requirement => ({ any });

const BASE = {
  // ---- everyone signed in ------------------------------------------------------------------------------
  home: {},
  /** Your own sign-in security: password, two-step verification, passkeys and sessions. */
  'me.security': {},
  'me.notifications': {},
  'me.profile': { employee: true },
  'me.details.edit': { employee: true, any: ['self.update_contact'] },
  'me.details.request': { employee: true, any: ['self.read'] },
  'inbox.approvals': {},
  /** Deciding an approval: the API checks that the caller is the approver (or holds approvals.manage). */
  'inbox.approvals.decide': { alsoChecks: ['approvals.manage'] },
  'inbox.tasks': {},
  /** Completing a task: the assignee, or someone who manages workflows. */
  'inbox.tasks.complete': { alsoChecks: ['workflows.manage'] },

  // ---- people ----------------------------------------------------------------------------------------
  'people.directory': anyOf('employees.read'),
  /** A person's profile: the API decides per record (ADR-0161). */
  'people.record': {},
  'people.create': anyOf('employees.create'),
  /** The change route HR and self-service share; each page asks for its own capability. */
  'people.changes': anyOf('employees.update', 'self.update_contact'),
  'people.edit': anyOf('employees.update'),
  'people.terminate': anyOf('employees.terminate'),
  'people.inviteSignIn': anyOf('users.invite'),
  /** Emergency contacts: the API checks write access to the field on that person. */
  'people.emergencyContacts': {},
  'people.visibility': anyOf('self.read'),
  'people.orgChart': {},
  'people.documents': {},
  'people.documents.attach': anyOf('documents.manage'),
  'people.imports': anyOf('imports.run'),
  'people.compliance': anyOf('compliance.read'),
  'documents.manage': { any: ['documents.manage'], workspace: true },
  'documents.signOwn': anyOf('documents.sign'),
  /** Countersigning: the API checks that the caller is the named countersigner. */
  'documents.countersign': {},

  // ---- time ------------------------------------------------------------------------------------------
  'time.overview': {},
  'time.timeOff': {},
  'time.timeOff.request': anyOf('leave.request', 'leave.record'),
  /** Asking for your own time off. */
  'time.timeOff.requestOwn': { employee: true, any: ['leave.request'] },
  /** Cancelling: your own request, or one you may record leave for. */
  'time.timeOff.cancel': { alsoChecks: ['leave.record'] },
  'time.timeOff.calendarFeed': {},
  'time.timeOff.calendar': anyOf('leave.read'),
  'time.leave.adjust': anyOf('leave.adjust'),
  'time.sickness.record': anyOf('absence.record'),
  'time.rota': anyOf('rota.view', 'rota.view_own'),
  'time.rota.team': anyOf('rota.view'),
  'time.rota.manage': anyOf('rota.manage'),
  'time.rota.swap': anyOf('rota.swap_request'),
  /** Answering or withdrawing a swap: the colleague asked, or the person who asked. */
  'time.rota.swapRespond': { alsoChecks: ['rota.manage'] },
  'time.clock': anyOf('time.clock', 'time.manage'),
  'time.clock.punch': anyOf('time.clock'),
  'time.clock.kiosks': anyOf('time.manage'),
  'time.clock.pin': anyOf('time.clock', 'time.manage'),
  'time.timesheets': anyOf('time.clock', 'time.read'),
  'time.timesheets.team': anyOf('time.read'),
  'time.timesheets.submit': anyOf('time.clock', 'time.correct'),
  'time.timesheets.export': anyOf('time.export'),
  'time.approvals': anyOf('leave.approve', 'time.approve', 'approvals.act'),

  // ---- pay -------------------------------------------------------------------------------------------
  'pay.payroll': anyOf('payroll.read'),
  'pay.payroll.manage': anyOf('payroll.manage'),
  'pay.payroll.export': anyOf('payroll.export'),
  'pay.payslips': anyOf('payslips.read_own', 'payslips.manage'),
  'pay.payslips.manage': anyOf('payslips.manage'),

  // ---- IT: devices, accounts and automation ---------------------------------------------------------
  'it.assets': anyOf('assets.read_own', 'assets.read'),
  /** The whole asset register (read-only for HR admins, ADR-0189). */
  'it.assets.register': anyOf('assets.read'),
  'it.assets.manage': anyOf('assets.manage'),
  'it.assets.acknowledge': anyOf('assets.acknowledge'),
  'it.integrations': anyOf('integrations.read'),
  'it.integrations.manage': anyOf('integrations.manage'),
  'it.automation': { any: ['automation.read'], workspace: true },
  'it.automation.manage': { any: ['automation.manage'], workspace: true },

  // ---- reports ---------------------------------------------------------------------------------------
  'reports.catalogue': anyOf('reports.run', 'reports.read_team'),
  /** Running, previewing and saving reports (rows are always limited by scope). */
  'reports.use': { any: ['reports.run', 'reports.read_team'], alsoChecks: ['reports.manage'] },
  'reports.build': anyOf('reports.run'),
  'reports.scheduled': anyOf('reports.schedule'),
  /** The data exports page lists destinations and scheduled exports, so it needs both. */
  'reports.dataExports': { all: ['exports.schedule', 'exports.destinations'] },
  'reports.dataExports.schedule': anyOf('exports.schedule'),
  'reports.dataExports.destinations': anyOf('exports.destinations'),

  // ---- compliance ------------------------------------------------------------------------------------
  'compliance.overview': anyOf('compliance.read'),
  'compliance.record': anyOf('compliance.record'),
  'compliance.manage': { any: ['compliance.manage'], workspace: true },
  'compliance.reports': anyOf('compliance.reports'),
  /** The law-change feed (the API lists it for compliance.law_changes). */
  'compliance.lawChanges': anyOf('compliance.law_changes'),
  'compliance.lawChanges.acknowledge': anyOf('compliance.law_changes'),

  // ---- privacy ---------------------------------------------------------------------------------------
  'privacy.overview': { any: ['privacy.read'], workspace: true },
  'privacy.requests.manage': { any: ['privacy.dsr'], workspace: true },
  'privacy.requests.erase': { any: ['privacy.erase'], workspace: true },
  'privacy.incidents.manage': { any: ['privacy.incidents'], workspace: true },
  'privacy.retention.manage': { any: ['privacy.retention'], workspace: true },
  'privacy.notices.manage': { any: ['privacy.notices'], workspace: true },
  'privacy.subprocessors.subscribe': { any: ['privacy.read'], workspace: true },
  'privacy.dpa.accept': { any: ['account.dpa'], workspace: true },
  /** The account exports and closure page loads both, so it needs both (owners). */
  'privacy.exports': { all: ['account.export', 'account.close'], workspace: true },
  'privacy.companyExport': { any: ['account.export'], workspace: true },
  'privacy.closeAccount': { any: ['account.close'], workspace: true },

  // ---- company and help ------------------------------------------------------------------------------
  'company.billing': { any: ['billing.manage'], workspace: true },
  'help.centre': anyOf('help.read'),
  /** Admin roles contact Thapsus-HR support (ADR-0163). */
  'help.support': anyOf('support.ticket'),
  'help.support.manage': anyOf('support.manage'),
  /** Employees and managers ask their own HR team instead (ADR-0163). */
  'help.contactHr': { all: ['hr.contact'], none: ['support.ticket'] },
  'help.contactHr.ask': anyOf('hr.contact'),
  /** Ask HR: the staff-managed flag, and the customer's opt-in and the region (askHr, from the API). */
  'askHr.use': { any: ['ai.ask'], feature: 'aiAssistant', askHr: true },

  // ---- settings --------------------------------------------------------------------------------------
  'settings.organisation': { any: ['org.manage'], workspace: true },
  'settings.roles': anyOf('roles.read'),
  'settings.roles.manage': anyOf('roles.manage'),
  'settings.users': anyOf('roles.read'),
  'settings.users.assign': anyOf('roles.assign'),
  'settings.users.manage': { any: ['settings.manage'], workspace: true },
  'settings.sso': { any: ['settings.read'], workspace: true },
  'settings.sso.manage': { any: ['settings.manage'], workspace: true },
  'settings.signInPolicy': { any: ['settings.read'], workspace: true },
  'settings.signInPolicy.manage': { any: ['settings.manage'], workspace: true },
  'settings.domains': { any: ['settings.read'], workspace: true },
  'settings.domains.manage': { any: ['settings.manage'], workspace: true },
  /** SCIM provisioning: workspace settings admins and IT admins (ADR-0189). */
  'settings.scim': anyOf('settings.read', 'scim.manage'),
  'settings.scim.manage': anyOf('settings.manage', 'scim.manage'),
  'settings.securityCentre': { any: ['audit.read'], workspace: true },
  'settings.securityCentre.manage': { any: ['settings.manage'], workspace: true },
  'settings.supportAccess': { any: ['settings.read'], workspace: true },
  'settings.supportAccess.manage': { any: ['settings.manage'], workspace: true },
  'settings.approvalChains': { any: ['approvals.manage'], workspace: true },
  'settings.workflows': { any: ['workflows.read'], workspace: true },
  'settings.workflows.manage': { any: ['workflows.manage'], workspace: true },
  /** Anyone who approves things can hand their approvals to a colleague while they are away. */
  'settings.delegations': anyOf('approvals.act', 'approvals.manage', 'leave.approve', 'time.approve'),
  /** Your own delegations (the API keeps them to the caller's own approvals). */
  'settings.delegations.manage': {},
  'settings.leave': { any: ['leave.manage'], workspace: true },
  'settings.calendars': { any: ['leave.manage'], workspace: true },
  'settings.absence': { any: ['absence.manage', 'leave.manage'], workspace: true },
  'settings.absence.manage': { any: ['absence.manage'], workspace: true },
  'settings.coverRules': { any: ['leave.manage'], workspace: true },
  'settings.time': { any: ['time.manage'], workspace: true },
  'settings.api': { any: ['settings.manage'], feature: 'publicApi', workspace: true },
  'settings.webhooks': { any: ['webhooks.manage'], feature: 'webhooks', workspace: true },
  'settings.streams': { any: ['settings.manage'], feature: 'auditStreaming', workspace: true },
  'settings.sandbox': { any: ['settings.manage'], feature: 'sandboxes', notInSandbox: true, workspace: true },
  'settings.branding': { any: ['settings.read'], feature: 'customBranding', workspace: true },
  'settings.branding.manage': { any: ['settings.manage'], feature: 'customBranding', workspace: true },
  'settings.askHr': { any: ['settings.read'], feature: 'aiAssistant', workspace: true },
  'settings.askHr.manage': {
    any: ['settings.manage', 'documents.manage'],
    feature: 'aiAssistant',
    workspace: true,
  },
  'settings.askHr.sources': { any: ['documents.manage'], feature: 'aiAssistant', workspace: true },
  'settings.features': { any: ['settings.read'], workspace: true },
  'settings.features.manage': { any: ['settings.manage'], workspace: true },
  'settings.developers': { any: ['settings.read'], workspace: true },
} satisfies Record<string, Requirement>;

export type CapabilityKey = keyof typeof BASE | 'settings.index';

/**
 * Every page of the app (`apps/web/app/app/**\/page.tsx`, dynamic segments as `[id]`), with the
 * capability needed to open it and, where it differs, the one needed to change what it shows. A page
 * someone may open but not change is read-only; one they cannot open is hidden from navigation and
 * shows the not-allowed state when opened directly.
 */
export interface PageAccess {
  path: string;
  view: CapabilityKey;
  manage?: CapabilityKey;
  /**
   * The page explains itself to someone who may not open it, and offers another way (the directory points
   * to the org chart); the app shell lets it render instead of its general not-allowed state.
   */
  ownRefusal?: true;
}

export const PAGES: readonly PageAccess[] = [
  { path: '/app', view: 'home' },
  { path: '/app/me', view: 'me.profile' },
  { path: '/app/me/details', view: 'me.profile', manage: 'me.details.edit' },
  { path: '/app/welcome', view: 'me.profile' },
  { path: '/app/notifications', view: 'me.notifications' },
  { path: '/app/security', view: 'me.security' },
  { path: '/app/approvals', view: 'inbox.approvals', manage: 'inbox.approvals.decide' },
  { path: '/app/approvals/[id]', view: 'inbox.approvals', manage: 'inbox.approvals.decide' },
  { path: '/app/tasks', view: 'inbox.tasks', manage: 'inbox.tasks.complete' },
  { path: '/app/tasks/[id]', view: 'inbox.tasks', manage: 'inbox.tasks.complete' },
  { path: '/app/people', view: 'people.directory', manage: 'people.create', ownRefusal: true },
  { path: '/app/people/new', view: 'people.create' },
  { path: '/app/people/[id]', view: 'people.record', manage: 'people.edit' },
  { path: '/app/org-chart', view: 'people.orgChart' },
  { path: '/app/documents', view: 'people.documents' },
  { path: '/app/documents/[id]', view: 'people.documents', manage: 'documents.signOwn' },
  { path: '/app/imports', view: 'people.imports' },
  { path: '/app/time', view: 'time.overview' },
  { path: '/app/time-off', view: 'time.timeOff', manage: 'time.timeOff.requestOwn' },
  { path: '/app/time-off/[id]', view: 'time.timeOff', manage: 'time.timeOff.cancel' },
  { path: '/app/rota', view: 'time.rota', manage: 'time.rota.manage' },
  { path: '/app/clock', view: 'time.clock', manage: 'time.clock.punch' },
  { path: '/app/timesheets', view: 'time.timesheets', manage: 'time.timesheets.submit' },
  { path: '/app/timesheets/[id]', view: 'time.timesheets', manage: 'inbox.approvals.decide' },
  { path: '/app/payroll', view: 'pay.payroll', manage: 'pay.payroll.manage' },
  { path: '/app/payroll/periods/[id]', view: 'pay.payroll', manage: 'pay.payroll.manage' },
  { path: '/app/payslips', view: 'pay.payslips', manage: 'pay.payslips.manage' },
  { path: '/app/payslips/[id]', view: 'pay.payslips' },
  { path: '/app/assets', view: 'it.assets', manage: 'it.assets.manage' },
  { path: '/app/assets/[id]', view: 'it.assets.register', manage: 'it.assets.manage' },
  { path: '/app/integrations', view: 'it.integrations', manage: 'it.integrations.manage' },
  { path: '/app/automation', view: 'it.automation', manage: 'it.automation.manage' },
  { path: '/app/reports', view: 'reports.catalogue' },
  { path: '/app/reports/builder', view: 'reports.build' },
  { path: '/app/reports/schedules', view: 'reports.scheduled' },
  { path: '/app/reports/exports', view: 'reports.dataExports' },
  { path: '/app/reports/ready/[id]', view: 'reports.catalogue' },
  { path: '/app/reports/runs/[id]', view: 'reports.catalogue' },
  { path: '/app/compliance', view: 'compliance.overview' },
  { path: '/app/compliance/right-to-work', view: 'compliance.overview', manage: 'compliance.record' },
  { path: '/app/compliance/right-to-work/[id]', view: 'compliance.overview', manage: 'compliance.record' },
  { path: '/app/compliance/i9', view: 'compliance.overview', manage: 'compliance.record' },
  { path: '/app/compliance/matrix', view: 'compliance.overview', manage: 'compliance.record' },
  { path: '/app/compliance/reports/gender-pay-gap', view: 'compliance.reports' },
  { path: '/app/compliance/reports/eeo-1', view: 'compliance.reports' },
  { path: '/app/compliance/reports/pay-transparency', view: 'compliance.reports' },
  {
    path: '/app/compliance/law-changes',
    view: 'compliance.lawChanges',
    manage: 'compliance.lawChanges.acknowledge',
  },
  { path: '/app/privacy', view: 'privacy.overview', manage: 'privacy.requests.manage' },
  { path: '/app/privacy/retention', view: 'privacy.overview', manage: 'privacy.retention.manage' },
  { path: '/app/privacy/incidents', view: 'privacy.overview', manage: 'privacy.incidents.manage' },
  { path: '/app/privacy/legal', view: 'privacy.overview', manage: 'privacy.notices.manage' },
  { path: '/app/privacy/exports', view: 'privacy.exports', manage: 'privacy.companyExport' },
  { path: '/app/billing', view: 'company.billing' },
  { path: '/app/help', view: 'help.centre' },
  { path: '/app/help/[slug]', view: 'help.centre' },
  { path: '/app/support', view: 'help.support' },
  { path: '/app/support/[id]', view: 'help.support' },
  { path: '/app/contact-hr', view: 'help.contactHr', manage: 'help.contactHr.ask' },
  { path: '/app/contact-hr/[id]', view: 'help.contactHr.ask' },
  { path: '/app/ask', view: 'askHr.use' },
  { path: '/app/settings', view: 'settings.index' },
  { path: '/app/settings/organisation', view: 'settings.organisation' },
  { path: '/app/settings/roles', view: 'settings.roles', manage: 'settings.roles.manage' },
  { path: '/app/settings/roles/new', view: 'settings.roles.manage' },
  { path: '/app/settings/roles/compare', view: 'settings.roles' },
  { path: '/app/settings/roles/[id]', view: 'settings.roles', manage: 'settings.roles.manage' },
  { path: '/app/settings/users', view: 'settings.users', manage: 'settings.users.assign' },
  { path: '/app/settings/users/[id]', view: 'settings.users', manage: 'settings.users.assign' },
  { path: '/app/settings/sso', view: 'settings.sso', manage: 'settings.sso.manage' },
  {
    path: '/app/settings/sign-in-policy',
    view: 'settings.signInPolicy',
    manage: 'settings.signInPolicy.manage',
  },
  { path: '/app/settings/domains', view: 'settings.domains', manage: 'settings.domains.manage' },
  { path: '/app/settings/scim', view: 'settings.scim', manage: 'settings.scim.manage' },
  {
    path: '/app/settings/security-centre',
    view: 'settings.securityCentre',
    manage: 'settings.securityCentre.manage',
  },
  {
    path: '/app/settings/support-access',
    view: 'settings.supportAccess',
    manage: 'settings.supportAccess.manage',
  },
  { path: '/app/settings/approval-chains', view: 'settings.approvalChains' },
  { path: '/app/settings/workflows', view: 'settings.workflows', manage: 'settings.workflows.manage' },
  { path: '/app/settings/delegations', view: 'settings.delegations' },
  { path: '/app/settings/leave', view: 'settings.leave' },
  { path: '/app/settings/calendars', view: 'settings.calendars' },
  { path: '/app/settings/absence', view: 'settings.absence', manage: 'settings.absence.manage' },
  { path: '/app/settings/time', view: 'settings.time' },
  { path: '/app/settings/api', view: 'settings.api' },
  { path: '/app/settings/webhooks', view: 'settings.webhooks' },
  { path: '/app/settings/audit-streams', view: 'settings.streams' },
  { path: '/app/settings/sandbox', view: 'settings.sandbox' },
  { path: '/app/settings/branding', view: 'settings.branding', manage: 'settings.branding.manage' },
  { path: '/app/settings/ask-hr', view: 'settings.askHr', manage: 'settings.askHr.manage' },
  { path: '/app/settings/features', view: 'settings.features', manage: 'settings.features.manage' },
];

const unique = (xs: readonly string[]) => [...new Set(xs)];

/** The settings index is open to anyone who may open at least one settings page. */
const SETTINGS_INDEX: Requirement = {
  any: unique(
    PAGES.filter((p) => p.path.startsWith('/app/settings/')).flatMap(
      (p) => (BASE as Record<string, Requirement>)[p.view]?.any ?? [],
    ),
  ),
};

export const CAPABILITIES: Readonly<Record<CapabilityKey, Requirement>> = {
  ...BASE,
  'settings.index': SETTINGS_INDEX,
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as CapabilityKey[];

export function isCapabilityKey(v: unknown): v is CapabilityKey {
  return typeof v === 'string' && Object.hasOwn(CAPABILITIES, v);
}

/** A permission test over the viewer's grants (wildcards included), as `actionMatches` decides. */
export type HasPermission = (permission: string) => boolean;

/** A has() built from a list of granted permission strings (a session's `permissions`). */
export function hasFromGrants(grants: readonly string[]): HasPermission {
  return (p) => grants.some((g) => actionMatches(g, p));
}

/**
 * What the map needs to know about the viewer. `features` are the workspace's flags: while they are not
 * known (undefined) feature checks pass, so a role preview or the first paint shows the feature's entry;
 * once known, a flag the workspace has not set uses its registry default.
 */
export interface CapabilityViewer {
  has: HasPermission;
  /** The same test over the roles assigned for the whole workspace only (absent: `has`). */
  hasWorkspace?: HasPermission;
  employeeId?: string | null;
  features?: Partial<Record<FeatureKey, boolean>>;
  askHr?: boolean;
  sandbox?: boolean;
}

const requirementOf = (c: CapabilityKey | Requirement): Requirement =>
  typeof c === 'string' ? CAPABILITIES[c] : c;

/**
 * Whether the permission parts (any, all) hold: what the API enforces before a route's handler, and what
 * the app's not-allowed state for a page checks.
 */
export function permits(
  has: HasPermission,
  c: CapabilityKey | Requirement,
  hasWorkspace: HasPermission = has,
): boolean {
  const r = requirementOf(c);
  const test = r.workspace ? hasWorkspace : has;
  if (r.any?.length && !r.any.some((p) => test(p))) return false;
  if (r.all?.length && !r.all.every((p) => test(p))) return false;
  return true;
}

/** Whether the viewer can see or do it: the permissions, plus none, employee, feature, Ask HR and sandbox. */
export function allows(v: CapabilityViewer, c: CapabilityKey | Requirement): boolean {
  const r = requirementOf(c);
  if (!permits(v.has, r, v.hasWorkspace)) return false;
  if (r.none?.some((p) => v.has(p))) return false;
  if (r.employee && !v.employeeId) return false;
  if (r.feature && v.features && !(v.features[r.feature] ?? FEATURE_FLAGS[r.feature].default)) return false;
  if (r.askHr && !v.askHr) return false;
  if (r.notInSandbox && v.sandbox) return false;
  return true;
}

/** Every permission a capability names (any, all, none and alsoChecks), for validation. */
export function namedPermissions(c: CapabilityKey | Requirement): string[] {
  const r = requirementOf(c);
  return unique([...(r.any ?? []), ...(r.all ?? []), ...(r.none ?? []), ...(r.alsoChecks ?? [])]);
}

/**
 * True when everyone who passes `ui`'s permission parts also passes `route`'s: a button gated by `ui`
 * never calls a route that refuses its holder for want of a permission. Decided on the permission
 * strings (the catalogue keys), not on wildcards.
 */
export function implies(ui: CapabilityKey | Requirement, route: CapabilityKey | Requirement): boolean {
  const u = requirementOf(ui);
  const r = requirementOf(route);
  // a route that needs company-wide permissions is not covered by an action that accepts a scoped role
  if (r.workspace && !u.workspace) return false;
  const uAll = new Set(u.all ?? []);
  if (!(r.all ?? []).every((p) => uAll.has(p))) return false;
  if (!r.any?.length) return true;
  const rAny = new Set(r.any);
  if ([...uAll].some((p) => rAny.has(p))) return true;
  return !!u.any?.length && u.any.every((p) => rAny.has(p));
}

const segments = (path: string) => path.split('?')[0]!.replace(/\/+$/, '').split('/').filter(Boolean);

/** The page entry for an app path (`/app/people/123` → `/app/people/[id]`), if the path is a page. */
export function pageFor(path: string): PageAccess | undefined {
  const want = segments(path);
  let best: { page: PageAccess; exact: number } | undefined;
  for (const page of PAGES) {
    const have = segments(page.path);
    if (have.length !== want.length) continue;
    let exact = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      if (have[i] === want[i]) exact++;
      else if (!/^\[.+\]$/.test(have[i]!)) {
        ok = false;
        break;
      }
    }
    if (ok && (!best || exact > best.exact)) best = { page, exact };
  }
  return best?.page;
}
