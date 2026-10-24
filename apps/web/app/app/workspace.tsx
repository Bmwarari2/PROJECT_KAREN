import {
  BarChart3,
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  Clock,
  CreditCard,
  FileText,
  Home,
  Inbox,
  Laptop,
  Lock,
  MessageCircleQuestionMark,
  Plus,
  Scale,
  Settings,
  ShieldCheck,
  Upload,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  allows,
  hasFromGrants,
  pageFor,
  permits,
  type CapabilityKey,
  type CapabilityViewer,
} from '@thapsus/core/capabilities';
import type { FeatureKey } from '@thapsus/core/features';
import type { SessionInfo } from '@/lib/api';

/**
 * The workspace map (ADR-0154): every module, its tabs and the quick actions. What each one needs comes
 * from the permission map in @thapsus/core (ADR-0188): a tab is shown when its page may be opened, an
 * action when its capability is held. The rail, the phone tab bar, the menu sheet, global search, the
 * home page's quick actions and the role preview all read this one list, so what a person can reach is
 * decided in one place. The API still enforces every permission and its scope; this only decides what
 * is shown.
 */

/** What the map needs to know about the viewer, with `can` for a capability of the permission map. */
export interface WorkspaceViewer extends CapabilityViewer {
  employeeId: string | null;
  askHr: boolean;
  can: (capability: CapabilityKey) => boolean;
}

export function viewerFromSession(
  s: Pick<SessionInfo, 'permissions' | 'employeeId'>,
  askHr = false,
  workspace: { features?: Partial<Record<FeatureKey, boolean>>; sandbox?: boolean } = {},
): WorkspaceViewer {
  const base: CapabilityViewer = {
    has: hasFromGrants(s.permissions),
    employeeId: s.employeeId,
    askHr,
    features: workspace.features,
    sandbox: workspace.sandbox,
  };
  return {
    ...base,
    employeeId: s.employeeId,
    askHr,
    can: (capability) => allows(base, capability),
  };
}

/** Whether the viewer may open a page at all (permissions only): pages they may not show the not-allowed state. */
export function mayOpenPage(v: Pick<CapabilityViewer, 'has'>, path: string): boolean {
  const page = pageFor(path);
  return !page || permits(v.has, page.view);
}

export type GroupKey = 'you' | 'workforce' | 'insights' | 'governance' | 'company' | 'support';
export const GROUPS: GroupKey[] = ['you', 'workforce', 'insights', 'governance', 'company', 'support'];

export interface ModuleTab {
  /** An app page in the permission map (PAGES); the tab shows when its page may be opened. */
  href: string;
  /** Message key of the tab label. */
  label: string;
  /** Active only on exactly this path (overview tabs whose path prefixes the others). */
  exact?: boolean;
}

/** Whether the viewer sees a tab: the view capability of its page, in the permission map. */
export function tabShown(v: WorkspaceViewer, tab: Pick<ModuleTab, 'href'>): boolean {
  const page = pageFor(tab.href);
  return !!page && v.can(page.view);
}

export interface WorkspaceModule {
  key: string;
  /** Message key of the module name. */
  label: string;
  /** Message key of a one-line description (search results, role preview). */
  description: string;
  icon: LucideIcon;
  group: GroupKey | 'home';
  tabs: ModuleTab[];
  /** Paths that belong to the module without being a tab (detail pages, wizards). */
  paths?: string[];
  /**
   * The module's index lists its pages (Settings, ADR-0181): on phones a page under it shows a back link
   * to the index and its own large title instead of the module's name.
   */
  drillDown?: boolean;
}

export const MODULES: WorkspaceModule[] = [
  {
    key: 'home',
    label: 'app.nav.home',
    description: 'app.ws.desc.home',
    icon: Home,
    group: 'home',
    tabs: [{ href: '/app', label: 'app.nav.home', exact: true }],
  },
  {
    key: 'me',
    label: 'app.ws.module.me',
    description: 'app.ws.desc.me',
    icon: UserRound,
    group: 'you',
    tabs: [
      { href: '/app/me', label: 'app.ws.tab.overview', exact: true },
      { href: '/app/me/details', label: 'app.ws.tab.myDetails' },
      { href: '/app/welcome', label: 'app.nav.onboarding' },
      { href: '/app/notifications', label: 'app.nav.notifications' },
      { href: '/app/security', label: 'app.nav.security' },
    ],
  },
  {
    key: 'inbox',
    label: 'app.ws.module.inbox',
    description: 'app.ws.desc.inbox',
    icon: Inbox,
    group: 'you',
    tabs: [
      { href: '/app/approvals', label: 'app.nav.approvals' },
      { href: '/app/tasks', label: 'app.nav.tasks' },
    ],
  },
  {
    key: 'people',
    label: 'app.nav.people',
    description: 'app.ws.desc.people',
    icon: Users,
    group: 'workforce',
    tabs: [
      { href: '/app/people', label: 'app.ws.tab.directory' },
      { href: '/app/org-chart', label: 'app.nav.orgChart' },
      { href: '/app/documents', label: 'app.nav.documents' },
      { href: '/app/imports', label: 'app.nav.imports' },
    ],
  },
  {
    key: 'time',
    label: 'app.ws.module.time',
    description: 'app.ws.desc.time',
    icon: CalendarDays,
    group: 'workforce',
    tabs: [
      { href: '/app/time', label: 'app.ws.tab.overview', exact: true },
      { href: '/app/time-off', label: 'app.nav.timeOff' },
      { href: '/app/rota', label: 'app.nav.rota' },
      { href: '/app/clock', label: 'app.nav.clock' },
      { href: '/app/timesheets', label: 'app.nav.timesheets' },
    ],
  },
  {
    key: 'pay',
    label: 'app.ws.module.pay',
    description: 'app.ws.desc.pay',
    icon: Wallet,
    group: 'workforce',
    tabs: [
      { href: '/app/payroll', label: 'app.nav.payroll' },
      { href: '/app/payslips', label: 'app.nav.payslips' },
    ],
  },
  {
    key: 'it',
    label: 'app.ws.module.it',
    description: 'app.ws.desc.it',
    icon: Laptop,
    group: 'workforce',
    tabs: [
      { href: '/app/assets', label: 'app.nav.assets' },
      { href: '/app/integrations', label: 'app.nav.integrations' },
      { href: '/app/automation', label: 'app.nav.automation' },
    ],
  },
  {
    key: 'reports',
    label: 'app.nav.reports',
    description: 'app.ws.desc.reports',
    icon: BarChart3,
    group: 'insights',
    tabs: [
      {
        href: '/app/reports',
        label: 'app.ws.tab.catalogue',
        exact: true,
      },
      { href: '/app/reports/builder', label: 'app.ws.tab.builder' },
      { href: '/app/reports/schedules', label: 'app.ws.tab.scheduled' },
      {
        href: '/app/reports/exports',
        label: 'app.ws.tab.exports',
      },
    ],
    paths: ['/app/reports/ready', '/app/reports/runs'],
  },
  {
    key: 'compliance',
    label: 'app.nav.compliance',
    description: 'app.ws.desc.compliance',
    icon: Scale,
    group: 'governance',
    tabs: [
      {
        href: '/app/compliance',
        label: 'compliance.nav.overview',
        exact: true,
      },
      {
        href: '/app/compliance/right-to-work',
        label: 'compliance.nav.rightToWork',
      },
      { href: '/app/compliance/i9', label: 'compliance.nav.i9' },
      { href: '/app/compliance/matrix', label: 'compliance.nav.matrix' },
      {
        href: '/app/compliance/reports/gender-pay-gap',
        label: 'compliance.nav.genderPayGap',
      },
      { href: '/app/compliance/reports/eeo-1', label: 'compliance.nav.eeo1' },
      {
        href: '/app/compliance/reports/pay-transparency',
        label: 'compliance.nav.payTransparency',
      },
      {
        href: '/app/compliance/law-changes',
        label: 'compliance.nav.lawChanges',
      },
    ],
  },
  {
    key: 'privacy',
    label: 'app.nav.privacy',
    description: 'app.ws.desc.privacy',
    icon: Lock,
    group: 'governance',
    tabs: [
      { href: '/app/privacy', label: 'app.ws.tab.privacyRequests', exact: true },
      { href: '/app/privacy/retention', label: 'app.ws.tab.retention' },
      { href: '/app/privacy/incidents', label: 'app.ws.tab.incidents' },
      { href: '/app/privacy/legal', label: 'app.ws.tab.legal' },
      { href: '/app/privacy/exports', label: 'app.ws.tab.privacyExports' },
    ],
  },
  {
    key: 'settings',
    label: 'app.nav.settings',
    description: 'app.ws.desc.settings',
    icon: Settings,
    group: 'company',
    drillDown: true,
    // The settings area lists and filters its own sections (settings/sections.ts); its index opens for
    // anyone who may open one of them (settings.index in the permission map).
    tabs: [
      {
        href: '/app/settings',
        label: 'app.nav.settings',
      },
    ],
  },
  {
    key: 'billing',
    label: 'app.nav.billing',
    description: 'app.ws.desc.billing',
    icon: CreditCard,
    group: 'company',
    tabs: [{ href: '/app/billing', label: 'app.nav.billing' }],
  },
  {
    key: 'help',
    label: 'app.ws.module.help',
    description: 'app.ws.desc.help',
    icon: CircleHelp,
    group: 'support',
    tabs: [
      { href: '/app/help', label: 'app.nav.help' },
      // admins contact Thapsus-HR support; employees and managers ask their own HR team (ADR-0163)
      { href: '/app/support', label: 'app.nav.support' },
      {
        href: '/app/contact-hr',
        label: 'actionable.hr.tab',
      },
      { href: '/app/ask', label: 'app.nav.askHr' },
    ],
  },
];

/**
 * The phone tab bar (ADR-0180): up to five modules, Home first and the viewer's own profile last. People
 * who manage others get People; everyone else gets Pay. Every entry is a module the viewer can open.
 */
export function dockModules(modules: VisibleModule[], v: WorkspaceViewer): VisibleModule[] {
  const middle = v.can('people.directory') ? ['inbox', 'people', 'time'] : ['inbox', 'time', 'pay'];
  const pick = (key: string) => modules.find((m) => m.key === key);
  return ['home', ...middle, 'me'].flatMap((k) => {
    const m = pick(k);
    return m ? [m] : [];
  });
}

/** A module with only the tabs the viewer may open, or null when none is left. */
export interface VisibleModule extends Omit<WorkspaceModule, 'tabs'> {
  tabs: ModuleTab[];
  href: string;
}

export function visibleModules(v: WorkspaceViewer): VisibleModule[] {
  return MODULES.flatMap((m) => {
    const tabs = m.tabs.filter((t) => tabShown(v, t));
    return tabs.length ? [{ ...m, tabs, href: tabs[0]!.href }] : [];
  });
}

const tabMatches = (t: ModuleTab, path: string) =>
  t.exact ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);

/** The module and tab a path belongs to (longest matching tab wins), among the visible modules. */
export function locate(
  modules: VisibleModule[],
  path: string,
): { module: VisibleModule; tab: ModuleTab | null } | null {
  let best: { module: VisibleModule; tab: ModuleTab | null; len: number } | null = null;
  for (const m of modules) {
    for (const t of m.tabs)
      if (tabMatches(t, path) && (!best || t.href.length > best.len))
        best = { module: m, tab: t, len: t.href.length };
    for (const p of m.paths ?? [])
      if ((path === p || path.startsWith(`${p}/`)) && (!best || p.length > best.len))
        best = { module: m, tab: null, len: p.length };
  }
  return best ? { module: best.module, tab: best.tab } : null;
}

export const isTabActive = tabMatches;

/** Quick actions: shown on the home page and in global search, each gated by its capability. */
export interface QuickAction {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  capability: CapabilityKey;
}

export const ACTIONS: QuickAction[] = [
  {
    key: 'requestLeave',
    label: 'app.ws.action.requestLeave',
    href: '/app/time-off',
    icon: CalendarDays,
    capability: 'time.timeOff.requestOwn',
  },
  {
    key: 'clockIn',
    label: 'app.ws.action.clockIn',
    href: '/app/clock',
    icon: Clock,
    capability: 'time.clock.punch',
  },
  {
    key: 'approve',
    label: 'app.ws.action.approve',
    href: '/app/approvals',
    icon: ClipboardCheck,
    capability: 'inbox.approvals',
  },
  {
    key: 'addPerson',
    label: 'app.ws.action.addPerson',
    href: '/app/people/new',
    icon: UserPlus,
    capability: 'people.add',
  },
  {
    key: 'buildReport',
    label: 'app.ws.action.buildReport',
    href: '/app/reports/builder',
    icon: BarChart3,
    capability: 'reports.builder',
  },
  {
    key: 'import',
    label: 'app.ws.action.import',
    href: '/app/imports',
    icon: Upload,
    capability: 'people.imports',
  },
  {
    key: 'newRole',
    label: 'app.ws.action.newRole',
    href: '/app/settings/roles/new',
    icon: Plus,
    capability: 'settings.roles.manage',
  },
  {
    key: 'assignRoles',
    label: 'app.ws.action.assignRoles',
    href: '/app/settings/users',
    icon: ShieldCheck,
    capability: 'settings.users.assign',
  },
  {
    key: 'myDocuments',
    label: 'app.ws.action.myDocuments',
    href: '/app/documents',
    icon: FileText,
    capability: 'people.documents',
  },
  {
    key: 'askHr',
    label: 'app.ws.action.askHr',
    href: '/app/ask',
    icon: MessageCircleQuestionMark,
    capability: 'askHr.ask',
  },
];

export function visibleActions(v: WorkspaceViewer): QuickAction[] {
  // the action's own capability, and the page it opens
  return ACTIONS.filter((a) => v.can(a.capability) && tabShown(v, a));
}
