import type { FeatureKey } from '@thapsus/core/features';

/**
 * The settings area: every section, its group and who may open it. The same permission keys the
 * API checks decide visibility (the API still enforces them), so the sub-navigation, the settings
 * index and the app sidebar never disagree.
 */
export type SettingsGroup =
  'workspace' | 'documents' | 'access' | 'signIn' | 'approvals' | 'timeOff' | 'time' | 'platform';

export interface SettingsSection {
  key: string;
  href: string;
  group: SettingsGroup;
  visible: (has: (permission: string) => boolean) => boolean;
  /**
   * A platform setting (Phase 9): its title and summary are under `platform.links.<platform>` instead of
   * `admin.section.<key>` (`sectionMessages` in section-text.ts; message keys stay out of this module,
   * which every page loads through the workspace map).
   */
  platform?: string;
  /** Shown only while this workspace feature is on (platform settings). */
  feature?: FeatureKey;
  /** Not offered inside a sandbox (a sandbox cannot have sandboxes). */
  notInSandbox?: boolean;
  /** Outside the settings area (the developer documentation): listed on the index only. */
  external?: boolean;
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  'workspace',
  'documents',
  'access',
  'signIn',
  'approvals',
  'timeOff',
  'time',
  'platform',
];

const manage = (has: (permission: string) => boolean) => has('settings.manage');
const read = (has: (permission: string) => boolean) => has('settings.read');

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'organisation',
    href: '/app/settings/organisation',
    group: 'workspace',
    visible: (has) => has('org.manage'),
  },
  // document templates and who signs for the company (Phase 16 part C, ADR-0194, ADR-0196)
  {
    key: 'documentTemplates',
    href: '/app/settings/documents/templates',
    group: 'documents',
    visible: (has) => has('documents.manage'),
  },
  {
    key: 'signatories',
    href: '/app/settings/documents/signatories',
    group: 'documents',
    visible: (has) => has('documents.manage'),
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
  // Enterprise platform settings (Phase 9); hidden while their feature is off for the workspace.
  {
    key: 'api',
    href: '/app/settings/api',
    group: 'platform',
    visible: manage,
    platform: 'api',
    feature: 'publicApi',
  },
  {
    key: 'webhooks',
    href: '/app/settings/webhooks',
    group: 'platform',
    visible: manage,
    platform: 'webhooks',
    feature: 'webhooks',
  },
  {
    key: 'streams',
    href: '/app/settings/audit-streams',
    group: 'platform',
    visible: manage,
    platform: 'streams',
    feature: 'auditStreaming',
  },
  {
    key: 'sandbox',
    href: '/app/settings/sandbox',
    group: 'platform',
    visible: manage,
    platform: 'sandbox',
    feature: 'sandboxes',
    notInSandbox: true,
  },
  {
    key: 'branding',
    href: '/app/settings/branding',
    group: 'platform',
    visible: read,
    platform: 'branding',
    feature: 'customBranding',
  },
  {
    key: 'askHr',
    href: '/app/settings/ask-hr',
    group: 'platform',
    visible: read,
    platform: 'askHr',
    feature: 'aiAssistant',
  },
  {
    key: 'features',
    href: '/app/settings/features',
    group: 'platform',
    visible: read,
    platform: 'features',
  },
  {
    key: 'developers',
    href: '/developers',
    group: 'platform',
    visible: read,
    platform: 'developers',
    external: true,
  },
];

/**
 * The sections the viewer may open. Without `context` (the workspace map, which runs before the
 * workspace's features are known), feature-gated sections count as visible.
 */
export function visibleSections(
  has: (permission: string) => boolean,
  context?: { feature: (key: FeatureKey) => boolean; sandbox: boolean },
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (s) =>
      s.visible(has) &&
      (!context || !s.feature || context.feature(s.feature)) &&
      !(context?.sandbox && s.notInSandbox),
  );
}

/** The section a settings path belongs to (the longest matching href), if any. */
export function sectionFor(path: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.filter(
    (s) => !s.external && (path === s.href || path.startsWith(`${s.href}/`)),
  ).sort((a, b) => b.href.length - a.href.length)[0];
}
