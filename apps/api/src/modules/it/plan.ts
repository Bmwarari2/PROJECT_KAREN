/**
 * Joiner / leaver plans: the exact provider calls Thapsus-HR will make for one employee. The dry-run
 * preview returns this plan; execution persists the very same operations (with idempotency keys) and
 * runs them, so what an admin previews is what happens. Pure functions — no I/O.
 *
 * Microsoft Graph v1.0 (https://graph.microsoft.com/v1.0), application permissions (least privilege per call):
 *  - create user          POST /users                                  User.Create
 *    https://learn.microsoft.com/en-us/graph/api/user-post-users
 *  - assign/remove licence POST /users/{upn}/assignLicense {addLicenses, removeLicenses}   LicenseAssignment.ReadWrite.All
 *    https://learn.microsoft.com/en-us/graph/api/user-assignlicense
 *  - add to group         POST /groups/{id}/members/$ref {"@odata.id"}  GroupMember.ReadWrite.All
 *    https://learn.microsoft.com/en-us/graph/api/group-post-members
 *  - block sign-in        PATCH /users/{upn} {accountEnabled:false}     User.EnableDisableAccount.All + User.Read.All
 *    https://learn.microsoft.com/en-us/graph/api/user-update
 *  - revoke sessions      POST /users/{upn}/revokeSignInSessions         User.RevokeSessions.All
 *    https://learn.microsoft.com/en-us/graph/api/user-revokesigninsessions
 * Google Workspace (Admin SDK Directory API v1 and Enterprise License Manager v1, per their discovery documents):
 *  - insert user   POST https://admin.googleapis.com/admin/directory/v1/users           admin.directory.user
 *    https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/insert
 *  - add member    POST .../admin/directory/v1/groups/{groupKey}/members               admin.directory.group.member
 *    https://developers.google.com/workspace/admin/directory/reference/rest/v1/members/insert
 *  - suspend       PATCH .../admin/directory/v1/users/{userKey} {suspended:true}       admin.directory.user
 *  - sign out      POST .../admin/directory/v1/users/{userKey}/signOut                 admin.directory.user.security
 *    https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/signOut
 *  - licences      POST/DELETE https://licensing.googleapis.com/apps/licensing/v1/product/{productId}/sku/{skuId}/user[/{userId}]   apps.licensing
 *    https://developers.google.com/workspace/admin/licensing/reference/rest/v1/licenseAssignments
 */
export type Provider = 'microsoft365' | 'google_workspace';
export type Lifecycle = 'joiner' | 'leaver';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
export const LICENSING = 'https://licensing.googleapis.com/apps/licensing/v1';

/** Least-privilege scopes requested from the customer (shown on the integrations page and in the docs). */
export const SCOPES: Record<Provider, string[]> = {
  microsoft365: [
    'User.Create',
    'User.Read.All',
    'User.EnableDisableAccount.All',
    'User.RevokeSessions.All',
    'LicenseAssignment.ReadWrite.All',
    'GroupMember.ReadWrite.All',
  ],
  google_workspace: [
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.user.security',
    'https://www.googleapis.com/auth/admin.directory.group.member',
    'https://www.googleapis.com/auth/apps.licensing',
  ],
};

/** Stand-ins resolved at execution time. Generated passwords are never stored, logged or shown. */
export const PASSWORD_PLACEHOLDER = '[generated at execution; never stored]';
export const USER_ID_PLACEHOLDER = '{userId}';

export interface ItSettings {
  /** e.g. "{first}.{last}" or "{f}{last}"; used when the employee has no work email in the domain. */
  usernameFormat?: string;
  /** Days before the start date that the account is created (default 3). */
  joinerLeadDays?: number;
  /** When leaver steps run: at the end of the last working day (default) or as soon as the leave is recorded. */
  leaverTiming?: 'end_of_last_day' | 'immediately';
  /** Run automatically from lifecycle events (default true); otherwise only from "Run now". */
  autoExecute?: boolean;
  /** Hires backdated by more than this many days are not provisioned automatically (default 7). */
  maxJoinerBackdateDays?: number;
  /** Google: default organisational unit. */
  defaultOrgUnitPath?: string;
}

export interface PlanEmployee {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  displayName: string;
  jobTitle: string | null;
  department: string | null;
  departmentId: string | null;
  entityId: string | null;
  locationId: string | null;
  country: string | null;
  workEmail: string | null;
}
export interface PlanRule {
  id: string;
  name: string;
  priority: number;
  match: { entityId?: string; departmentId?: string; locationId?: string; jobTitleContains?: string };
  licences: Array<{ skuId: string; productId?: string }>;
  groups: string[];
  org_unit_path: string | null;
}
export interface PlanAccount {
  principalName: string;
  remoteId: string | null;
  licences: Array<{ skuId: string; productId?: string }>;
}
export interface PlannedOp {
  seq: number;
  op:
    | 'create_user'
    | 'assign_licence'
    | 'add_group'
    | 'block_sign_in'
    | 'revoke_sessions'
    | 'remove_licence'
    | 'suspend_user'
    | 'sign_out';
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  target: string;
}
export interface Plan {
  provider: Provider;
  lifecycle: Lifecycle;
  principalName: string;
  matchedRules: string[];
  operations: PlannedOp[];
  /** Why there is nothing to do (e.g. a leaver with no known account in this directory). */
  skipped?: 'noKnownAccount';
}

export function ruleMatches(r: PlanRule, e: PlanEmployee): boolean {
  const m = r.match ?? {};
  if (m.entityId && m.entityId !== e.entityId) return false;
  if (m.departmentId && m.departmentId !== e.departmentId) return false;
  if (m.locationId && m.locationId !== e.locationId) return false;
  if (m.jobTitleContains && !(e.jobTitle ?? '').toLowerCase().includes(m.jobTitleContains.toLowerCase()))
    return false;
  return true;
}

const ascii = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Work email in the connection's domain, else the username format (ASCII-folded, lower case). */
export function principalNameFor(e: PlanEmployee, domain: string, format = '{first}.{last}'): string {
  if (e.workEmail && e.workEmail.toLowerCase().endsWith(`@${domain.toLowerCase()}`))
    return e.workEmail.toLowerCase();
  const first = ascii(e.preferredName || e.firstName) || 'user';
  const last = ascii(e.lastName) || ascii(e.employeeNumber);
  const local = format
    .replace('{first}', first)
    .replace('{last}', last)
    .replace('{f}', first.charAt(0))
    .replace('{number}', ascii(e.employeeNumber))
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
  return `${local || ascii(e.employeeNumber)}@${domain.toLowerCase()}`;
}

const enc = encodeURIComponent;
const uniqBy = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

export function buildPlan(
  provider: Provider,
  conn: { domain: string; settings: ItSettings },
  rules: PlanRule[],
  e: PlanEmployee,
  lifecycle: Lifecycle,
  account?: PlanAccount,
): Plan {
  const matched = [...rules]
    .sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1))
    .filter((r) => ruleMatches(r, e));
  const licences = uniqBy(
    matched.flatMap((r) => r.licences),
    (l) => `${l.productId ?? ''}/${l.skuId}`,
  );
  const groups = [...new Set(matched.flatMap((r) => r.groups))];
  const orgUnit =
    matched.find((r) => r.org_unit_path)?.org_unit_path ?? conn.settings.defaultOrgUnitPath ?? '/';
  const upn = account?.principalName ?? principalNameFor(e, conn.domain, conn.settings.usernameFormat);
  // A leaver is only processed for an account Thapsus-HR created, or one that matches their work email —
  // never for a generated name that might belong to someone else.
  const knownEmail = !!e.workEmail && e.workEmail.toLowerCase().endsWith(`@${conn.domain.toLowerCase()}`);
  if (lifecycle === 'leaver' && !account && !knownEmail)
    return {
      provider,
      lifecycle,
      principalName: upn,
      matchedRules: matched.map((r) => r.id),
      operations: [],
      skipped: 'noKnownAccount',
    };
  const ops: Array<Omit<PlannedOp, 'seq'>> = [];
  const nickname = upn
    .split('@')[0]!
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 64);

  if (provider === 'microsoft365') {
    if (lifecycle === 'joiner') {
      ops.push({
        op: 'create_user',
        method: 'POST',
        url: `${GRAPH}/users`,
        target: upn,
        body: {
          accountEnabled: true,
          displayName: e.displayName,
          givenName: e.preferredName || e.firstName,
          surname: e.lastName,
          mailNickname: nickname,
          userPrincipalName: upn,
          employeeId: e.employeeNumber.slice(0, 16),
          ...(e.jobTitle ? { jobTitle: e.jobTitle } : {}),
          ...(e.department ? { department: e.department } : {}),
          ...(e.country ? { usageLocation: e.country } : {}),
          passwordProfile: { forceChangePasswordNextSignIn: true, password: PASSWORD_PLACEHOLDER },
        },
      });
      if (licences.length)
        ops.push({
          op: 'assign_licence',
          method: 'POST',
          url: `${GRAPH}/users/${enc(upn)}/assignLicense`,
          target: licences.map((l) => l.skuId).join(','),
          body: {
            addLicenses: licences.map((l) => ({ skuId: l.skuId, disabledPlans: [] })),
            removeLicenses: [],
          },
        });
      for (const g of groups)
        ops.push({
          op: 'add_group',
          method: 'POST',
          url: `${GRAPH}/groups/${enc(g)}/members/$ref`,
          target: g,
          body: { '@odata.id': `${GRAPH}/directoryObjects/${USER_ID_PLACEHOLDER}` },
        });
    } else {
      ops.push({
        op: 'block_sign_in',
        method: 'PATCH',
        url: `${GRAPH}/users/${enc(upn)}`,
        target: upn,
        body: { accountEnabled: false },
      });
      ops.push({
        op: 'revoke_sessions',
        method: 'POST',
        url: `${GRAPH}/users/${enc(upn)}/revokeSignInSessions`,
        target: upn,
      });
      const remove = uniqBy([...(account?.licences ?? []), ...licences], (l) => l.skuId);
      if (remove.length)
        ops.push({
          op: 'remove_licence',
          method: 'POST',
          url: `${GRAPH}/users/${enc(upn)}/assignLicense`,
          target: remove.map((l) => l.skuId).join(','),
          body: { addLicenses: [], removeLicenses: remove.map((l) => l.skuId) },
        });
    }
  } else {
    if (lifecycle === 'joiner') {
      ops.push({
        op: 'create_user',
        method: 'POST',
        url: `${DIRECTORY}/users`,
        target: upn,
        body: {
          primaryEmail: upn,
          name: { givenName: e.preferredName || e.firstName, familyName: e.lastName },
          password: PASSWORD_PLACEHOLDER,
          changePasswordAtNextLogin: true,
          orgUnitPath: orgUnit,
          externalIds: [{ type: 'organization', value: e.employeeNumber }],
          ...(e.jobTitle || e.department
            ? {
                organizations: [
                  {
                    primary: true,
                    ...(e.jobTitle ? { title: e.jobTitle } : {}),
                    ...(e.department ? { department: e.department } : {}),
                  },
                ],
              }
            : {}),
        },
      });
      for (const l of licences)
        ops.push({
          op: 'assign_licence',
          method: 'POST',
          url: `${LICENSING}/product/${enc(l.productId ?? 'Google-Apps')}/sku/${enc(l.skuId)}/user`,
          target: `${l.productId ?? 'Google-Apps'}/${l.skuId}`,
          body: { userId: upn },
        });
      for (const g of groups)
        ops.push({
          op: 'add_group',
          method: 'POST',
          url: `${DIRECTORY}/groups/${enc(g)}/members`,
          target: g,
          body: { email: upn, role: 'MEMBER' },
        });
    } else {
      ops.push({
        op: 'suspend_user',
        method: 'PATCH',
        url: `${DIRECTORY}/users/${enc(upn)}`,
        target: upn,
        body: { suspended: true },
      });
      ops.push({
        op: 'sign_out',
        method: 'POST',
        url: `${DIRECTORY}/users/${enc(upn)}/signOut`,
        target: upn,
      });
      const remove = uniqBy(
        [...(account?.licences ?? []), ...licences],
        (l) => `${l.productId ?? 'Google-Apps'}/${l.skuId}`,
      );
      for (const l of remove)
        ops.push({
          op: 'remove_licence',
          method: 'DELETE',
          url: `${LICENSING}/product/${enc(l.productId ?? 'Google-Apps')}/sku/${enc(l.skuId)}/user/${enc(upn)}`,
          target: `${l.productId ?? 'Google-Apps'}/${l.skuId}`,
        });
    }
  }
  return {
    provider,
    lifecycle,
    principalName: upn,
    matchedRules: matched.map((r) => r.id),
    operations: ops.map((o, i) => ({ seq: i + 1, ...o })),
  };
}
