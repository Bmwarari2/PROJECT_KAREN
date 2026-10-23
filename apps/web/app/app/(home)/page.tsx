import type { ApprovalItem, MeSummary, TaskItem } from '@/lib/dashboard-data';
import { serverApi } from '@/lib/server-api';
import { HomeDashboard } from './dashboard';

/**
 * Home (ADR-0154). The web server fetches what "needs your attention" shows, with the viewer's own
 * cookie and permissions, so the first HTML already has it; the dashboard fetches the rest itself.
 * Rendered per request and never cached (the /app layout).
 */
export default async function HomePage() {
  const [summary, approvals, tasks, onboarding] = await Promise.all([
    serverApi<MeSummary>('/v1/me/summary'),
    serverApi<ApprovalItem[]>('/v1/approvals?view=mine'),
    serverApi<TaskItem[]>('/v1/tasks?status=open'),
    serverApi<{ employee: { status: string } }>('/v1/me/onboarding'),
  ]);
  return <HomeDashboard initial={{ summary, approvals, tasks, onboarding }} />;
}
