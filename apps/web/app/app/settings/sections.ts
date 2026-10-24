import {
  allows,
  CAPABILITIES,
  pageFor,
  type CapabilityKey,
  type CapabilityViewer,
} from '@thapsus/core/capabilities';
import { FEATURE_KEYS, type FeatureKey } from '@thapsus/core/features';

/**
 * The settings area: every section, its group and how it is presented. Who may open a section comes
 * from the permission map in @thapsus/core (ADR-0188): the view capability of its page (or, for a row
 * that leaves the settings area, its own capability). The sub-navigation, the settings index, the app
 * sidebar and the role preview read the same entries, and the API enforces the same permissions.
 */
export type SettingsGroup = 'workspace' | 'access' | 'signIn' | 'approvals' | 'timeOff' | 'time' | 'platform';

export interface SettingsSection {
  key: string;
  href: string;
  group: SettingsGroup;
  /**
   * A platform setting (Phase 9): its title and summary are under `platform.links.<platform>` instead of
   * `admin.section.<key>` (`sectionMessages` in section-text.ts; message keys stay out of this module,
   * which every page loads through the workspace map).
   */
  platform?: string;
  /** Outside the settings area (the developer documentation): listed on the index only. */
  external?: boolean;
  /** The capability of a row that is not a page of the app (external rows). */
  capability?: CapabilityKey;
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  'workspace',
  'access',
  'signIn',
  'approvals',
  'timeOff',
  'time',
  'platform',
];

const S = (
  key: string,
  href: string,
  group: SettingsGroup,
  extra: Partial<Pick<SettingsSection, 'platform' | 'external' | 'capability'>> = {},
): SettingsSection => ({ key, href, group, ...extra });

export const SETTINGS_SECTIONS: SettingsSection[] = [
  S('organisation', '/app/settings/organisation', 'workspace'),
  S('roles', '/app/settings/roles', 'access'),
  S('users', '/app/settings/users', 'access'),
  S('sso', '/app/settings/sso', 'signIn'),
  S('signInPolicy', '/app/settings/sign-in-policy', 'signIn'),
  S('domains', '/app/settings/domains', 'signIn'),
  S('scim', '/app/settings/scim', 'signIn'),
  // the workspace's own security alerts and admin changes (ADR-0178): whoever may read its audit log
  S('securityCentre', '/app/settings/security-centre', 'signIn'),
  S('supportAccess', '/app/settings/support-access', 'signIn'),
  S('approvalChains', '/app/settings/approval-chains', 'approvals'),
  S('workflows', '/app/settings/workflows', 'approvals'),
  // Anyone who approves things can hand their approvals to a colleague while they are away.
  S('delegations', '/app/settings/delegations', 'approvals'),
  S('leave', '/app/settings/leave', 'timeOff'),
  S('calendars', '/app/settings/calendars', 'timeOff'),
  S('absence', '/app/settings/absence', 'timeOff'),
  S('time', '/app/settings/time', 'time'),
  // Enterprise platform settings (Phase 9); hidden while their feature is off for the workspace.
  S('api', '/app/settings/api', 'platform', { platform: 'api' }),
  S('webhooks', '/app/settings/webhooks', 'platform', { platform: 'webhooks' }),
  S('streams', '/app/settings/audit-streams', 'platform', { platform: 'streams' }),
  S('sandbox', '/app/settings/sandbox', 'platform', { platform: 'sandbox' }),
  S('branding', '/app/settings/branding', 'platform', { platform: 'branding' }),
  S('askHr', '/app/settings/ask-hr', 'platform', { platform: 'askHr' }),
  S('features', '/app/settings/features', 'platform', { platform: 'features' }),
  S('developers', '/developers', 'platform', {
    platform: 'developers',
    external: true,
    capability: 'settings.developers',
  }),
];

/** The capability that opens a section: its page's view capability in the permission map. */
export function sectionCapability(s: SettingsSection): CapabilityKey {
  const key = s.capability ?? pageFor(s.href)?.view;
  if (!key) throw new Error(`settings section ${s.key}: ${s.href} is not a page in the permission map`);
  return key;
}

/** The workspace feature a section needs, if any (from its capability). */
export function sectionFeature(s: SettingsSection): FeatureKey | undefined {
  return CAPABILITIES[sectionCapability(s)].feature;
}

/**
 * The sections the viewer may open. Without `context` (the workspace map, which runs before the
 * workspace's features are known), feature-gated sections count as visible.
 */
export function visibleSections(
  has: (permission: string) => boolean,
  context?: { feature: (key: FeatureKey) => boolean; sandbox: boolean },
  hasWorkspace: (permission: string) => boolean = has,
): SettingsSection[] {
  const viewer: CapabilityViewer = {
    has,
    // workspace settings need their permissions company-wide (ADR-0188)
    hasWorkspace,
    // a section is about the workspace, not the viewer's own record
    employeeId: 'any',
    askHr: true,
    sandbox: context?.sandbox,
    features: context
      ? (Object.fromEntries(FEATURE_KEYS.map((k) => [k, context.feature(k)])) as Record<FeatureKey, boolean>)
      : undefined,
  };
  return SETTINGS_SECTIONS.filter((s) => allows(viewer, sectionCapability(s)));
}

/** The section a settings path belongs to (the longest matching href), if any. */
export function sectionFor(path: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.filter(
    (s) => !s.external && (path === s.href || path.startsWith(`${s.href}/`)),
  ).sort((a, b) => b.href.length - a.href.length)[0];
}
