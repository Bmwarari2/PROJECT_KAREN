import type { Metadata } from 'next';
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
  return <BackofficeShell theme={theme}>{children}</BackofficeShell>;
}
