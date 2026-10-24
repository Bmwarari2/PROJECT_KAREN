import type { Metadata } from 'next';
import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';
import { BackofficeShell } from './shell';

// Staff pages are always rendered per request and never cached (Cache-Control: private, no-store).
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('backoffice.title'), robots: { index: false, follow: false } };
}

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  const { theme } = await serverContext();
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
      <BackofficeShell theme={theme}>{children}</BackofficeShell>
    </Messages>
  );
}
