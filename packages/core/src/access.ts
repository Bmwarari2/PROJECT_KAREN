import {
  actionMatches,
  grantFieldAccess,
  scopeMatches,
  type FieldAccess,
  type Principal,
  type RoleGrant,
  type Scope,
  type ScopeType,
  type Target,
} from './permissions';

/**
 * Access catalogue and the privilege-escalation rules for role management (ADR-0120, ADR-0121).
 *
 *  - PERMISSION_CATALOGUE lists every permission key a role may hold, grouped by product area. A role
 *    may also hold an area wildcard (`leave.*`) or a category wildcard (`vault.read:*`). `*` is the
 *    owner's alone. Keys marked `admin` make a role an admin role (MFA is then mandatory).
 *  - EMPLOYEE_FIELDS lists the employee field keys used for field-level access (`employee.<key>`).
 *  - The coverage helpers decide whether a caller may define or hand out a role: everything the role
 *    grants must already be held by the caller, at a scope at least as wide as the one being granted.
 */

export interface PermissionDef {
  key: string;
  /** Holding this key makes a role an admin role (workspace configuration, access, bulk or special-category data). */
  admin?: boolean;
}
export interface PermissionArea {
  area: string;
  permissions: PermissionDef[];
}

const p = (key: string, admin = false): PermissionDef => (admin ? { key, admin } : { key });
const VAULT_CATEGORIES = ['health', 'sickness', 'disability', 'diversity', 'eeo', 'immigration'] as const;

export const PERMISSION_CATALOGUE: PermissionArea[] = [
  { area: 'self', permissions: [p('self.read'), p('self.update_contact')] },
  {
    area: 'employees',
    permissions: [
      p('employees.read'),
      p('employees.history'),
      p('employees.create', true),
      p('employees.update', true),
      p('employees.terminate', true),
    ],
  },
  { area: 'org', permissions: [p('org.reporting'), p('org.manage', true)] },
  {
    area: 'documents',
    permissions: [
      p('documents.read_own'),
      p('documents.upload_own'),
      p('documents.sign'),
      p('documents.read'),
      p('documents.manage', true),
    ],
  },
  {
    area: 'workflows',
    permissions: [
      p('workflows.tasks'),
      p('workflows.read'),
      p('workflows.start'),
      p('workflows.manage', true),
    ],
  },
  { area: 'approvals', permissions: [p('approvals.act'), p('approvals.manage', true)] },
  { area: 'automation', permissions: [p('automation.read'), p('automation.manage', true)] },
  {
    area: 'leave',
    permissions: [
      p('leave.request'),
      p('leave.read'),
      p('leave.approve'),
      p('leave.record'),
      p('leave.adjust'),
      p('leave.manage', true),
    ],
  },
  { area: 'absence', permissions: [p('absence.read'), p('absence.record'), p('absence.manage', true)] },
  {
    area: 'rota',
    permissions: [
      p('rota.view_own'),
      p('rota.swap_request'),
      p('rota.availability'),
      p('rota.view'),
      p('rota.manage'),
    ],
  },
  {
    area: 'time',
    permissions: [
      p('time.clock'),
      p('time.read'),
      p('time.approve'),
      p('time.correct'),
      p('time.export'),
      p('time.manage', true),
    ],
  },
  {
    area: 'payslips',
    permissions: [p('payslips.read_own'), p('payslips.read', true), p('payslips.manage', true)],
  },
  {
    area: 'payroll',
    permissions: [p('payroll.read', true), p('payroll.export', true), p('payroll.manage', true)],
  },
  {
    area: 'reports',
    permissions: [
      p('reports.read_team'),
      p('reports.read'),
      p('reports.run'),
      p('reports.schedule'),
      p('reports.manage', true),
    ],
  },
  { area: 'imports', permissions: [p('imports.run', true)] },
  {
    area: 'exports',
    permissions: [p('exports.run', true), p('exports.schedule', true), p('exports.destinations', true)],
  },
  {
    area: 'vault',
    permissions: [
      ...VAULT_CATEGORIES.map((c) => p(`vault.read:${c}`, true)),
      ...VAULT_CATEGORIES.map((c) => p(`vault.write:${c}`, true)),
    ],
  },
  {
    area: 'privacy',
    permissions: [
      p('privacy.read', true),
      p('privacy.dsr', true),
      p('privacy.erase', true),
      p('privacy.incidents', true),
      p('privacy.notices', true),
      p('privacy.retention', true),
    ],
  },
  { area: 'audit', permissions: [p('audit.read', true), p('audit.export', true)] },
  { area: 'users', permissions: [p('users.invite', true)] },
  { area: 'roles', permissions: [p('roles.read', true), p('roles.manage', true), p('roles.assign', true)] },
  { area: 'settings', permissions: [p('settings.read', true), p('settings.manage', true)] },
  { area: 'support', permissions: [p('support.ticket'), p('support.manage', true)] },
  // asking the company's own HR team (ADR-0163); support.ticket contacts Thapsus-HR's support
  { area: 'hr', permissions: [p('hr.contact')] },
  { area: 'help', permissions: [p('help.read')] },
  { area: 'ai', permissions: [p('ai.ask')] },
  {
    area: 'compliance',
    permissions: [
      p('compliance.read'),
      p('compliance.record', true),
      p('compliance.reports', true),
      p('compliance.reports_exact', true),
      p('compliance.law_changes', true),
      p('compliance.manage', true),
    ],
  },
  {
    area: 'assets',
    permissions: [p('assets.read_own'), p('assets.acknowledge'), p('assets.read'), p('assets.manage', true)],
  },
  { area: 'integrations', permissions: [p('integrations.read', true), p('integrations.manage', true)] },
  { area: 'webhooks', permissions: [p('webhooks.manage', true)] },
  { area: 'billing', permissions: [p('billing.manage', true)] },
  {
    area: 'account',
    permissions: [p('account.dpa', true), p('account.export', true), p('account.close', true)],
  },
];

export const PERMISSION_KEYS: string[] = PERMISSION_CATALOGUE.flatMap((a) => a.permissions.map((x) => x.key));
const AREAS = new Set(PERMISSION_CATALOGUE.map((a) => a.area));
/** Category wildcards such as `vault.read:*` (a prefix shared by catalogue keys before a colon). */
const CATEGORY_PREFIXES = new Set(
  PERMISSION_KEYS.filter((k) => k.includes(':')).map((k) => k.slice(0, k.indexOf(':'))),
);
const ADMIN_KEYS = PERMISSION_CATALOGUE.flatMap((a) =>
  a.permissions.filter((x) => x.admin).map((x) => x.key),
);

export type PermissionProblem = 'unknownPermission' | 'ownerOnly';

/** Why a permission string cannot be held by a custom role, or undefined when it is valid. */
export function permissionProblem(perm: string): PermissionProblem | undefined {
  if (perm === '*') return 'ownerOnly';
  if (PERMISSION_KEYS.includes(perm)) return undefined;
  if (perm.endsWith('.*') && AREAS.has(perm.slice(0, -2))) return undefined;
  if (perm.endsWith(':*') && CATEGORY_PREFIXES.has(perm.slice(0, -2))) return undefined;
  return 'unknownPermission';
}

/** Concrete catalogue keys a permission string grants (a wildcard expands to its area). */
export function expandPermission(perm: string): string[] {
  return PERMISSION_KEYS.filter((k) => actionMatches(perm, k));
}

/** True when the permissions include a key that makes a role an admin role. */
export function isAdminGrade(permissions: string[]): boolean {
  return permissions.some((perm) => perm === '*' || ADMIN_KEYS.some((k) => actionMatches(perm, k)));
}

// ---- employee fields ------------------------------------------------------------------------------------
export type FieldSection = 'core' | 'personal' | 'job' | 'pay' | 'contract';
export interface FieldCatalogueEntry {
  /** Field key under the `employee` resource (as checked by fieldAccess(principal, 'employee', key)). */
  key: string;
  section: FieldSection;
}

const f = (section: FieldSection, ...keys: string[]) => keys.map((key) => ({ key, section }));
export const EMPLOYEE_FIELDS: FieldCatalogueEntry[] = [
  ...f(
    'core',
    'id',
    'displayName',
    'status',
    'employeeNumber',
    'startDate',
    'endDate',
    'workEmail',
    'workPhone',
    'photoUrl',
    'manager',
  ),
  ...f(
    'personal',
    'legalFirstName',
    'legalLastName',
    'preferredName',
    'pronouns',
    'dateOfBirth',
    'personalEmail',
    'personalPhone',
    'address',
    'nationality',
    'emergencyContacts',
  ),
  ...f(
    'job',
    'jobTitle',
    'position',
    'department',
    'location',
    'entity',
    'costCentre',
    'employmentType',
    'fte',
    'weeklyHours',
    'workPattern',
    'flsaStatus',
  ),
  ...f('pay', 'pay.amount', 'pay.grade'),
  ...f('contract', 'contract.type', 'contract.noticePeriod', 'contract.probation'),
];
/**
 * Field groups that may be granted with a wildcard (`employee.pay.*`). Custom fields and objects are
 * `employee.custom.<key>` (validated against the tenant); `bank` is reserved for payroll details.
 */
export const EMPLOYEE_FIELD_GROUPS = ['pay', 'contract', 'custom', 'bank'] as const;
const FIELD_KEYS = new Set(EMPLOYEE_FIELDS.map((x) => `employee.${x.key}`));
const FIELD_LEVELS: FieldAccess[] = ['none', 'read', 'write'];

export type FieldProblem = 'unknownField' | 'ownerOnly' | 'invalidAccess';

/** Why a field-access entry cannot be held by a custom role. `customKeys` are the tenant's custom field and object keys. */
export function fieldAccessProblem(
  key: string,
  level: string,
  customKeys: Iterable<string> = [],
): FieldProblem | undefined {
  if (!FIELD_LEVELS.includes(level as FieldAccess)) return 'invalidAccess';
  if (key === '*') return 'ownerOnly';
  if (key === 'employee.*' || FIELD_KEYS.has(key)) return undefined;
  if (EMPLOYEE_FIELD_GROUPS.some((g) => key === `employee.${g}.*`)) return undefined;
  if (key.startsWith('employee.custom.') && new Set(customKeys).has(key.slice('employee.custom.'.length)))
    return undefined;
  return 'unknownField';
}

// ---- coverage (privilege-escalation guards) -------------------------------------------------------------
const RANK: Record<FieldAccess, number> = { none: 0, read: 1, write: 2 };

export interface RoleDefinition {
  permissions: string[];
  fieldAccess: Record<string, FieldAccess>;
}

/** Permissions in `perms` that no grant covers (a wildcard is covered only by an equal or wider wildcard). */
export function uncoveredPermissions(
  grants: Array<Pick<RoleGrant, 'permissions'>>,
  perms: string[],
): string[] {
  return perms.filter((perm) => !grants.some((g) => g.permissions.some((c) => actionMatches(c, perm))));
}

/**
 * Field keys where `def` would grant more than the grants hold. Every key either side mentions is
 * probed (plus `extraProbes`, e.g. every catalogue field), each resolved the way the engine resolves it
 * (exact key, then the most specific wildcard), so a wide wildcard cannot hide a narrower denial.
 */
export function excessFieldAccess(
  grants: Array<Pick<RoleGrant, 'fieldAccess'>>,
  def: Record<string, FieldAccess>,
  extraProbes: string[] = [],
): string[] {
  const probes = new Set([
    ...Object.keys(def),
    ...grants.flatMap((g) => Object.keys(g.fieldAccess)),
    ...extraProbes,
  ]);
  const out: string[] = [];
  for (const key of probes) {
    const wanted = grantFieldAccess({ fieldAccess: def }, key) ?? 'none';
    if (wanted === 'none') continue;
    const held = grants.reduce<FieldAccess>((best, g) => {
      const a = grantFieldAccess(g, key) ?? 'none';
      return RANK[a] > RANK[best] ? a : best;
    }, 'none');
    if (RANK[wanted] > RANK[held]) out.push(key);
  }
  return out.sort();
}

/** What is known about the person receiving an assignment (for self and own-team scopes). */
export interface Assignee {
  /** The assignee's employee record as a permission target (absent when the user has no employee record). */
  target?: Target | null;
  /** The assignee is the caller. */
  isCaller?: boolean;
  /** The caller is in the assignee's solid-line management chain, so the assignee's team is inside the caller's. */
  inCallersTeam?: boolean;
}

/**
 * Whether a caller's grant scope covers a requested assignment scope, i.e. the requested scope reaches
 * no record the grant does not. Delegated authority never counts (a temporary delegate cannot hand out
 * lasting access).
 */
export function scopeCovers(
  caller: Principal,
  held: Scope,
  requested: Scope,
  assignee: Assignee = {},
): boolean {
  if (held.type === 'all') return true;
  if (requested.type === 'all') return false;
  const own: Principal = { ...caller, delegatedFromEmployeeIds: [] };
  switch (requested.type) {
    case 'entity':
    case 'country':
    case 'department':
    case 'location': {
      const values = requested.values ?? [];
      return (
        held.type === requested.type &&
        values.length > 0 &&
        values.every((v) => (held.values ?? []).includes(v))
      );
    }
    case 'self':
      return !!assignee.target && scopeMatches(own, held, assignee.target);
    case 'own_team':
      return (
        held.type === 'own_team' && !!caller.employeeId && (!!assignee.isCaller || !!assignee.inCallersTeam)
      );
    default:
      return false;
  }
}

export interface AssignmentCheck {
  /** The caller holds `roles.assign` at a scope covering the requested one. */
  mayAssign: boolean;
  permissions: string[];
  fields: string[];
}

/** Checks that the caller could hand out `def` at `scope` to the assignee without exceeding their own access. */
export function checkAssignment(
  caller: Principal,
  def: RoleDefinition,
  scope: Scope,
  assignee: Assignee = {},
  extraProbes: string[] = [],
): AssignmentCheck {
  const covering = caller.grants.filter((g) => scopeCovers(caller, g.scope, scope, assignee));
  return {
    mayAssign: covering.some((g) => g.permissions.some((c) => actionMatches(c, 'roles.assign'))),
    permissions: uncoveredPermissions(covering, def.permissions),
    fields: excessFieldAccess(covering, def.fieldAccess, extraProbes),
  };
}

/** Probe keys for field coverage: every catalogue field and group under `employee`. */
export function fieldProbes(customKeys: Iterable<string> = []): string[] {
  return [
    'employee.*',
    ...EMPLOYEE_FIELDS.map((x) => `employee.${x.key}`),
    ...EMPLOYEE_FIELD_GROUPS.map((g) => `employee.${g}.*`),
    ...[...customKeys].map((k) => `employee.custom.${k}`),
  ];
}

export const SCOPE_TYPES: ScopeType[] = [
  'all',
  'entity',
  'country',
  'department',
  'location',
  'own_team',
  'self',
];
/** Scope types that name values (ids or country codes). */
export const VALUED_SCOPES: ScopeType[] = ['entity', 'country', 'department', 'location'];
