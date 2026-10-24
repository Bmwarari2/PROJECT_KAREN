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
import type { SessionInfo } from '@/lib/api';
import { visibleSections } from './settings/sections';

/**
 * The workspace map (ADR-0154): every module, its tabs and the quick actions, each with the
 * permission that gates it. The rail, the module tabs, global search, the home page's quick actions
 * and the role preview all read this one list, so what a person can reach is decided in one place.
 * The API still enforces every permission and its scope; this only decides what is shown.
 */

/** What the map needs to know about the viewer. `has` is a permission test (wildcards included). */
export interface WorkspaceViewer {
  has: (permission: string) => boolean;
  employeeId: string | null;
  askHr: boolean;
}

export function viewerFromSession(
  s: Pick<SessionInfo, 'permissions' | 'employeeId'>,
  askHr = false,
): WorkspaceViewer {
  return {
    has: (p) =>
      s.permissions.some((g) => g === '*' || g === p || (g.endsWith('.*') && p.startsWith(g.slice(0, -1)))),
    employeeId: s.employeeId,
    askHr,
  };
}

export type GroupKey = 'you' | 'workforce' | 'insights' | 'governance' | 'company' | 'support';
export const GROUPS: GroupKey[] = ['you', 'workforce', 'insights', 'governance', 'company', 'support'];

export interface ModuleTab {
  href: string;
  /** Message key of the tab label. */
  label: string;
  show: (v: WorkspaceViewer) => boolean;
  /** Active only on exactly this path (overview tabs whose path prefixes the others). */
  exact?: boolean;
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
}

const any =
  (...ps: string[]) =>
  (v: WorkspaceViewer) =>
    ps.some((p) => v.has(p));
const always = () => true;
const hasEmployee = (v: WorkspaceViewer) => !!v.employeeId;

export const MODULES: WorkspaceModule[] = [
  {
    key: 'home',
    label: 'app.nav.home',
    description: 'app.ws.desc.home',
    icon: Home,
    group: 'home',
    tabs: [{ href: '/app', label: 'app.nav.home', show: always, exact: true }],
  },
  {
    key: 'me',
    label: 'app.ws.module.me',
    description: 'app.ws.desc.me',
    icon: UserRound,
    group: 'you',
    tabs: [
      { href: '/app/me', label: 'app.ws.tab.overview', show: hasEmployee, exact: true },
      { href: '/app/me/details', label: 'app.ws.tab.myDetails', show: hasEmployee },
      { href: '/app/welcome', label: 'app.nav.onboarding', show: hasEmployee },
      { href: '/app/notifications', label: 'app.nav.notifications', show: always },
      { href: '/app/security', label: 'app.nav.security', show: always },
    ],
  },
  {
    key: 'inbox',
    label: 'app.ws.module.inbox',
    description: 'app.ws.desc.inbox',
    icon: Inbox,
    group: 'you',
    tabs: [
      { href: '/app/approvals', label: 'app.nav.approvals', show: always },
      { href: '/app/tasks', label: 'app.nav.tasks', show: always },
    ],
  },
  {
    key: 'people',
    label: 'app.nav.people',
    description: 'app.ws.desc.people',
    icon: Users,
    group: 'workforce',
    tabs: [
      { href: '/app/people', label: 'app.ws.tab.directory', show: any('employees.read') },
      { href: '/app/org-chart', label: 'app.nav.orgChart', show: always },
      { href: '/app/documents', label: 'app.nav.documents', show: always },
      { href: '/app/imports', label: 'app.nav.imports', show: any('imports.run') },
    ],
  },
  {
    key: 'time',
    label: 'app.ws.module.time',
    description: 'app.ws.desc.time',
    icon: CalendarDays,
    group: 'workforce',
    tabs: [
      { href: '/app/time', label: 'app.ws.tab.overview', show: always, exact: true },
      { href: '/app/time-off', label: 'app.nav.timeOff', show: always },
      { href: '/app/rota', label: 'app.nav.rota', show: any('rota.view', 'rota.view_own') },
      { href: '/app/clock', label: 'app.nav.clock', show: any('time.clock', 'time.manage') },
      { href: '/app/timesheets', label: 'app.nav.timesheets', show: any('time.clock', 'time.read') },
    ],
  },
  {
    key: 'pay',
    label: 'app.ws.module.pay',
    description: 'app.ws.desc.pay',
    icon: Wallet,
    group: 'workforce',
    tabs: [
      { href: '/app/payroll', label: 'app.nav.payroll', show: any('payroll.read') },
      { href: '/app/payslips', label: 'app.nav.payslips', show: any('payslips.read_own', 'payslips.manage') },
    ],
  },
  {
    key: 'it',
    label: 'app.ws.module.it',
    description: 'app.ws.desc.it',
    icon: Laptop,
    group: 'workforce',
    tabs: [
      { href: '/app/assets', label: 'app.nav.assets', show: any('assets.read_own', 'assets.read') },
      { href: '/app/integrations', label: 'app.nav.integrations', show: any('integrations.read') },
      { href: '/app/automation', label: 'app.nav.automation', show: any('automation.read') },
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
        show: any('reports.run', 'reports.read_team'),
        exact: true,
      },
      { href: '/app/reports/builder', label: 'app.ws.tab.builder', show: any('reports.run') },
      { href: '/app/reports/schedules', label: 'app.ws.tab.scheduled', show: any('reports.schedule') },
      {
        href: '/app/reports/exports',
        label: 'app.ws.tab.exports',
        show: any('exports.run', 'exports.schedule', 'exports.destinations'),
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
        show: any('compliance.read'),
        exact: true,
      },
      {
        href: '/app/compliance/right-to-work',
        label: 'compliance.nav.rightToWork',
        show: any('compliance.read'),
      },
      { href: '/app/compliance/i9', label: 'compliance.nav.i9', show: any('compliance.read') },
      { href: '/app/compliance/matrix', label: 'compliance.nav.matrix', show: any('compliance.read') },
      {
        href: '/app/compliance/reports/gender-pay-gap',
        label: 'compliance.nav.genderPayGap',
        show: any('compliance.read'),
      },
      { href: '/app/compliance/reports/eeo-1', label: 'compliance.nav.eeo1', show: any('compliance.read') },
      {
        href: '/app/compliance/reports/pay-transparency',
        label: 'compliance.nav.payTransparency',
        show: any('compliance.read'),
      },
      {
        href: '/app/compliance/law-changes',
        label: 'compliance.nav.lawChanges',
        show: any('compliance.read', 'compliance.law_changes'),
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
      { href: '/app/privacy', label: 'app.ws.tab.privacyRequests', show: any('privacy.read'), exact: true },
      { href: '/app/privacy/retention', label: 'app.ws.tab.retention', show: any('privacy.read') },
      { href: '/app/privacy/incidents', label: 'app.ws.tab.incidents', show: any('privacy.read') },
      { href: '/app/privacy/legal', label: 'app.ws.tab.legal', show: any('privacy.read') },
      { href: '/app/privacy/exports', label: 'app.ws.tab.privacyExports', show: any('privacy.read') },
    ],
  },
  {
    key: 'settings',
    label: 'app.nav.settings',
    description: 'app.ws.desc.settings',
    icon: Settings,
    group: 'company',
    // The settings area lists and filters its own sections (settings/sections.ts).
    tabs: [
      {
        href: '/app/settings',
        label: 'app.nav.settings',
        show: (v) => v.has('settings.read') || visibleSections(v.has).length > 0,
      },
    ],
  },
  {
    key: 'billing',
    label: 'app.nav.billing',
    description: 'app.ws.desc.billing',
    icon: CreditCard,
    group: 'company',
    tabs: [{ href: '/app/billing', label: 'app.nav.billing', show: any('billing.manage') }],
  },
  {
    key: 'help',
    label: 'app.ws.module.help',
    description: 'app.ws.desc.help',
    icon: CircleHelp,
    group: 'support',
    tabs: [
      { href: '/app/help', label: 'app.nav.help', show: always },
      { href: '/app/support', label: 'app.nav.support', show: any('support.ticket') },
      { href: '/app/ask', label: 'app.nav.askHr', show: (v) => v.askHr },
    ],
  },
];

/**
 * The phone tab bar (ADR-0180): up to five modules, Home first and the viewer's own profile last. People
 * who manage others get People; everyone else gets Pay. Every entry is a module the viewer can open.
 */
export function dockModules(modules: VisibleModule[], v: WorkspaceViewer): VisibleModule[] {
  const middle = v.has('employees.read') ? ['inbox', 'people', 'time'] : ['inbox', 'time', 'pay'];
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
    const tabs = m.tabs.filter((t) => t.show(v));
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

/** Quick actions: shown on the home page and in global search, gated like the tabs. */
export interface QuickAction {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  show: (v: WorkspaceViewer) => boolean;
}

export const ACTIONS: QuickAction[] = [
  {
    key: 'requestLeave',
    label: 'app.ws.action.requestLeave',
    href: '/app/time-off',
    icon: CalendarDays,
    show: hasEmployee,
  },
  {
    key: 'clockIn',
    label: 'app.ws.action.clockIn',
    href: '/app/clock',
    icon: Clock,
    show: any('time.clock'),
  },
  {
    key: 'approve',
    label: 'app.ws.action.approve',
    href: '/app/approvals',
    icon: ClipboardCheck,
    show: always,
  },
  {
    key: 'addPerson',
    label: 'app.ws.action.addPerson',
    href: '/app/people/new',
    icon: UserPlus,
    show: any('employees.create'),
  },
  {
    key: 'buildReport',
    label: 'app.ws.action.buildReport',
    href: '/app/reports/builder',
    icon: BarChart3,
    show: any('reports.run'),
  },
  {
    key: 'import',
    label: 'app.ws.action.import',
    href: '/app/imports',
    icon: Upload,
    show: any('imports.run'),
  },
  {
    key: 'newRole',
    label: 'app.ws.action.newRole',
    href: '/app/settings/roles/new',
    icon: Plus,
    show: any('roles.manage'),
  },
  {
    key: 'assignRoles',
    label: 'app.ws.action.assignRoles',
    href: '/app/settings/users',
    icon: ShieldCheck,
    show: any('roles.assign'),
  },
  {
    key: 'myDocuments',
    label: 'app.ws.action.myDocuments',
    href: '/app/documents',
    icon: FileText,
    show: always,
  },
  {
    key: 'askHr',
    label: 'app.ws.action.askHr',
    href: '/app/ask',
    icon: MessageCircleQuestionMark,
    show: (v) => v.askHr,
  },
];

export function visibleActions(v: WorkspaceViewer): QuickAction[] {
  return ACTIONS.filter((a) => a.show(v));
}
