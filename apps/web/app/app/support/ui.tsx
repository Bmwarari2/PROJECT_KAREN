/** Shared bits for the support pages. */
export const selectClass =
  'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

export interface TicketSummary {
  id: string;
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  planId: string;
  requesterUserId: string;
  requesterName: string | null;
  contextPath: string | null;
  sla: {
    firstResponse: { dueAt: string; state: string };
    resolution: { dueAt: string; state: string };
    flag: string;
  };
  createdAt: string;
  lastActivityAt: string;
}

export function slaTone(flag: string): 'success' | 'warning' | 'danger' | 'neutral' {
  return flag === 'breached'
    ? 'danger'
    : flag === 'at_risk'
      ? 'warning'
      : flag === 'met'
        ? 'success'
        : 'neutral';
}

export function duration(minutes: number, t: (k: string, v?: Record<string, string | number>) => string) {
  return minutes % 60 === 0
    ? t('support.hours', { count: minutes / 60 })
    : t('support.minutes', { count: minutes });
}
