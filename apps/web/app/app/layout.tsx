import { serverContext } from '@/lib/server';
import { AppShell } from './shell';

// Authenticated pages are always rendered per request and never cached (Cache-Control: private, no-store).
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { theme } = await serverContext();
  return <AppShell theme={theme}>{children}</AppShell>;
}
