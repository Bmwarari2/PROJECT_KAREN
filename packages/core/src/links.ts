/**
 * Deep links (ADR-0160): the one map from a thing the app talks about (an approval request, a task, a
 * leave request, a right-to-work check…) to the page of the web app that shows it. Notifications store
 * a target (type and id) and the API turns it into a route here; e-mails, web push, the notification
 * bell, the inbox and the web app's own links all use the same map, so a name or a notification always
 * lands on the same page.
 */
export const TARGET_TYPES = [
  'approval_request',
  'task',
  'leave_request',
  'employee',
  'document',
  'asset',
  'asset_assignment',
  'asset_return',
  'rtw_check',
  'report_run',
  'support_ticket',
  'privacy_request',
  'privacy_incident',
  'timesheet',
  'payroll_period',
  'payslip',
  'law_change',
  'hr_request',
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export interface LinkTarget {
  type: TargetType;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tabs of a person's profile that a link may open (`/app/people/[id]?tab=…`). */
export const PROFILE_TABS = ['overview', 'history', 'documents', 'time-off', 'compliance'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** A person's profile, optionally on one of its tabs. */
export function personHref(employeeId: string, tab?: ProfileTab): string {
  return `/app/people/${encodeURIComponent(employeeId)}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`;
}

const ROUTES: Record<TargetType, (id: string) => string> = {
  approval_request: (id) => `/app/approvals/${id}`,
  task: (id) => `/app/tasks/${id}`,
  leave_request: (id) => `/app/time-off/${id}`,
  employee: (id) => personHref(id),
  document: (id) => `/app/documents/${id}`,
  asset: (id) => `/app/assets/${id}`,
  // the holder's view: their own assets, opened at the handover to acknowledge
  asset_assignment: (id) => `/app/assets?ack=${id}`,
  // the register's view of the same assignment, opened at its return checklist (ADR-0191)
  asset_return: (id) => `/app/assets?return=${id}`,
  rtw_check: (id) => `/app/compliance/right-to-work/${id}`,
  report_run: (id) => `/app/reports/runs/${id}`,
  support_ticket: (id) => `/app/support/${id}`,
  privacy_request: (id) => `/app/privacy?request=${id}`,
  privacy_incident: () => '/app/privacy/incidents',
  timesheet: (id) => `/app/timesheets/${id}`,
  payroll_period: (id) => `/app/payroll/periods/${id}`,
  // the payslip's own page (ADR-0167)
  payslip: (id) => `/app/payslips/${id}`,
  law_change: () => '/app/compliance/law-changes',
  // the asker's view of a request to their HR team (HR open the task itself)
  hr_request: (id) => `/app/contact-hr/${id}`,
};

export function isTargetType(v: unknown): v is TargetType {
  return typeof v === 'string' && (TARGET_TYPES as readonly string[]).includes(v);
}

/** The page that shows a target; null for an unknown type or an id that is not a UUID. */
export function targetHref(target: { type: string; id: string } | null | undefined): string | null {
  if (!target || !isTargetType(target.type) || !UUID.test(target.id)) return null;
  return ROUTES[target.type](target.id.toLowerCase());
}

/**
 * The list page for a notification kind: where a notification without a target (or a stored link)
 * goes, so an older notification still opens somewhere useful.
 */
export function notificationFallbackHref(kind: string): string {
  const [area = '', what = ''] = kind.split('.');
  switch (area) {
    case 'approval':
      return '/app/approvals';
    case 'task':
      return '/app/tasks';
    case 'leave':
    case 'absence':
      return '/app/time-off';
    case 'document':
      return '/app/documents';
    case 'asset':
      return '/app/assets';
    case 'payslip':
      return '/app/payslips';
    case 'report':
      return '/app/reports';
    case 'support':
      return '/app/support';
    case 'time':
      return what.startsWith('timesheet') ? '/app/timesheets' : '/app/rota';
    case 'rota':
      return '/app/rota';
    case 'compliance':
      if (what.startsWith('rtw')) return '/app/compliance/right-to-work';
      if (what.startsWith('i9')) return '/app/compliance/i9';
      if (what.startsWith('expir')) return '/app/compliance/matrix';
      if (what === 'law_change') return '/app/compliance/law-changes';
      return '/app/compliance';
    case 'privacy':
      if (what === 'dsr') return '/app/privacy';
      if (what === 'incident') return '/app/privacy/incidents';
      if (what === 'dpa' || what === 'subprocessors') return '/app/privacy/legal';
      return '/app/privacy/exports';
    default:
      return '/app/notifications';
  }
}

/**
 * A stored link only counts as the place to go when it is a page of the app (a relative path under
 * /app), never an absolute or protocol-relative URL.
 */
export function safeAppLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/app') || link.startsWith('//')) return null;
  if (link !== '/app' && !/^\/app[/?#]/.test(link)) return null;
  return link;
}

/**
 * Where a notification opens: its target's page, else the target an older notification's dedupe key
 * names (approval and task reminders), else its stored link, else the list page for its kind.
 */
export function notificationHref(n: {
  kind: string;
  targetType?: string | null;
  targetId?: string | null;
  link?: string | null;
  dedupeKey?: string | null;
}): string {
  const direct = n.targetType && n.targetId ? targetHref({ type: n.targetType, id: n.targetId }) : null;
  const stored = safeAppLink(n.link);
  // a stored link that refines the target's page (`/app/documents/<id>?sign=…`) is kept
  if (direct)
    return stored && stored.startsWith(direct) && /^[?#]/.test(stored.slice(direct.length)) ? stored : direct;
  const legacy = legacyTarget(n.kind, n.dedupeKey ?? null);
  return (legacy && targetHref(legacy)) || stored || notificationFallbackHref(n.kind);
}

/** The target an older notification's dedupe key names, for the kinds whose keys carry an id. */
export function legacyTarget(kind: string, dedupeKey: string | null): LinkTarget | null {
  if (!dedupeKey) return null;
  const [prefix, id] = dedupeKey.split(':');
  if (!id || !UUID.test(id)) return null;
  if (
    (kind === 'approval.requested' && prefix === 'appr') ||
    (kind === 'approval.decided' && prefix === 'appr-done')
  )
    return { type: 'approval_request', id };
  if ((kind === 'task.due' && prefix === 'due') || (kind === 'task.overdue' && prefix === 'overdue'))
    return { type: 'task', id };
  return null;
}
