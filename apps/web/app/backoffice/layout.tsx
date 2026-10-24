import type { Metadata } from 'next';
import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';
import { serverApi } from '@/lib/server-api';
import { BackofficeShell } from './shell';
import type { StaffSession } from './ui';

// Staff pages are always rendered per request and never cached (Cache-Control: private, no-store).
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('backoffice.title'), robots: { index: false, follow: false } };
}

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  const { theme } = await serverContext();
  // the staff session comes with the HTML, so pages render at once (no shell placeholder); undefined
  // when signed out, and the shell then checks in the browser as before
  const staff = await serverApi<StaffSession>('/v1/backoffice/auth/session');
  return (
    <Messages
      ns={[
        'backoffice.*',
        'backoffice.nav',
        'backoffice.cell',
        'backoffice.roles',
        'backoffice.overview',
        'backoffice.elevation.banner',
        'backoffice.elevation.openAccess',
        'backoffice.elevation.problem.elevationRequired',
        'backoffice.stepUp.failed',
      ]}
    >
      <BackofficeShell theme={theme} initialStaff={staff ?? null}>
        {children}
      </BackofficeShell>
    </Messages>
  );
}
