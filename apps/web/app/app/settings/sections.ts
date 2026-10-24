/**
 * The settings area: every section, its group and who may open it. The same permission keys the
 * API checks decide visibility (the API still enforces them), so the sub-navigation, the settings
 * index and the app sidebar never disagree.
 */
export type SettingsGroup = 'workspace' | 'access' | 'signIn' | 'approvals' | 'timeOff' | 'time';

export interface SettingsSection {
  key: string;
  href: string;
  group: SettingsGroup;
  visible: (has: (permission: string) => boolean) => boolean;
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  'workspace',
  'access',
  'signIn',
  'approvals',
  'timeOff',
  'time',
];

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'organisation',
    href: '/app/settings/organisation',
    group: 'workspace',
    visible: (has) => has('org.manage'),
  },
  { key: 'roles', href: '/app/settings/roles', group: 'access', visible: (has) => has('roles.read') },
  { key: 'users', href: '/app/settings/users', group: 'access', visible: (has) => has('roles.read') },
  { key: 'sso', href: '/app/settings/sso', group: 'signIn', visible: (has) => has('settings.read') },
  {
    key: 'signInPolicy',
    href: '/app/settings/sign-in-policy',
    group: 'signIn',
    visible: (has) => has('settings.read'),
  },
  { key: 'domains', href: '/app/settings/domains', group: 'signIn', visible: (has) => has('settings.read') },
  { key: 'scim', href: '/app/settings/scim', group: 'signIn', visible: (has) => has('settings.read') },
  // the workspace's own security alerts and admin changes (ADR-0178): whoever may read its audit log
  {
    key: 'securityCentre',
    href: '/app/settings/security-centre',
    group: 'signIn',
    visible: (has) => has('audit.read'),
  },
  {
    key: 'supportAccess',
    href: '/app/settings/support-access',
    group: 'signIn',
    visible: (has) => has('settings.read'),
  },
  {
    key: 'approvalChains',
    href: '/app/settings/approval-chains',
    group: 'approvals',
    visible: (has) => has('approvals.manage'),
  },
  {
    key: 'workflows',
    href: '/app/settings/workflows',
    group: 'approvals',
    visible: (has) => has('workflows.read'),
  },
  // Anyone who approves things can hand their approvals to a colleague while they are away.
  {
    key: 'delegations',
    href: '/app/settings/delegations',
    group: 'approvals',
    visible: (has) =>
      has('approvals.act') || has('approvals.manage') || has('leave.approve') || has('time.approve'),
  },
  { key: 'leave', href: '/app/settings/leave', group: 'timeOff', visible: (has) => has('leave.manage') },
  {
    key: 'calendars',
    href: '/app/settings/calendars',
    group: 'timeOff',
    visible: (has) => has('leave.manage'),
  },
  {
    key: 'absence',
    href: '/app/settings/absence',
    group: 'timeOff',
    visible: (has) => has('absence.manage') || has('leave.manage'),
  },
  { key: 'time', href: '/app/settings/time', group: 'time', visible: (has) => has('time.manage') },
];

export function visibleSections(has: (permission: string) => boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => s.visible(has));
}
