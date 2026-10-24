import type { StaffSession } from '../ui';
import { serverApi } from '@/lib/server-api';
import { BackofficeOverview, type CellMetrics } from './overview';

/**
 * Back-office home (ADR-0175). The default view is this cell: its figures come with the HTML, so the page
 * paints its content at once instead of a placeholder that later moves (Lighthouse LCP and CLS). Other
 * regions, and roles without the figures, are fetched in the browser as before.
 */
export default async function BackofficeHomePage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const staff = await serverApi<StaffSession>('/v1/backoffice/auth/session');
  const initial =
    staff && (!region || region === staff.cell)
      ? await serverApi<CellMetrics>('/v1/backoffice/metrics')
      : undefined;
  return <BackofficeOverview initial={initial} />;
}
