import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';
import { serverSession } from '@/lib/server-session';
import { AppShell } from './shell';

// Authenticated pages are always rendered per request and never cached (Cache-Control: private, no-store).
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [{ theme }, session] = await Promise.all([serverContext(), serverSession()]);
  return (
    <Messages
      ns={[
        'app.nav',
        'app.ws',
        'app.home',
        'compliance.nav',
        'platform.branding.logoAlt',
        'platform.sandbox.banner',
      ]}
    >
      <AppShell theme={theme} initialSession={session}>
        {children}
      </AppShell>
    </Messages>
  );
}
