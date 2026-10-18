'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CalendarClock, CalendarDays, ClipboardList, Clock, DoorOpen, FileText, Home, Inbox, ListChecks, LogOut, Menu, Network, Settings, ShieldCheck, Upload, Users, Zap } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetTrigger, Sidebar, SidebarNav, Skeleton, TopBar, type NavItem } from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { LocaleSwitch, ThemeSwitch } from '@/components/client';
import { api, ApiProblem, type SessionInfo } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import type { ThemeChoice } from '@/lib/i18n-shared';

export const SessionContext = React.createContext<SessionInfo | null>(null);
export const useSession = () => React.useContext(SessionContext);

/** True when one of the session's grants covers the action (scope is enforced by the API). */
export function hasPermission(s: SessionInfo | null | undefined, p: string): boolean {
  return !!s?.permissions.some((g) => g === '*' || g === p || (g.endsWith('.*') && p.startsWith(g.slice(0, -1))));
}

/** Navigation entries; each feature phase adds its own (permission-filtered). */
export function navItems(t: (k: string) => string, s: SessionInfo, path: string): NavItem[] {
  const has = (p: string) => hasPermission(s, p);
  const items: Array<NavItem & { show: boolean }> = [
    { href: '/app', label: t('app.nav.home'), icon: <Home aria-hidden />, show: true },
    { href: '/app/welcome', label: t('app.nav.onboarding'), icon: <DoorOpen aria-hidden />, show: !!s.employeeId },
    { href: '/app/people', label: t('app.nav.people'), icon: <Users aria-hidden />, show: has('employees.read') },
    { href: '/app/org-chart', label: t('app.nav.orgChart'), icon: <Network aria-hidden />, show: true },
    { href: '/app/time-off', label: t('app.nav.timeOff'), icon: <CalendarDays aria-hidden />, show: true },
    { href: '/app/rota', label: t('app.nav.rota'), icon: <CalendarClock aria-hidden />, show: has('rota.view') || has('rota.view_own') },
    { href: '/app/clock', label: t('app.nav.clock'), icon: <Clock aria-hidden />, show: has('time.clock') || has('time.manage') },
    { href: '/app/timesheets', label: t('app.nav.timesheets'), icon: <ClipboardList aria-hidden />, show: has('time.clock') || has('time.read') },
    { href: '/app/tasks', label: t('app.nav.tasks'), icon: <ListChecks aria-hidden />, show: true },
    { href: '/app/approvals', label: t('app.nav.approvals'), icon: <Inbox aria-hidden />, show: true },
    { href: '/app/documents', label: t('app.nav.documents'), icon: <FileText aria-hidden />, show: true },
    { href: '/app/imports', label: t('app.nav.imports'), icon: <Upload aria-hidden />, show: has('imports.run') },
    { href: '/app/automation', label: t('app.nav.automation'), icon: <Zap aria-hidden />, show: has('automation.read') },
    { href: '/app/notifications', label: t('app.nav.notifications'), icon: <Bell aria-hidden />, show: true },
    { href: '/app/security', label: t('app.nav.security'), icon: <ShieldCheck aria-hidden />, show: true },
    { href: '/app/settings', label: t('app.nav.settings'), icon: <Settings aria-hidden />, show: has('settings.read') },
  ];
  return items.filter((i) => i.show).map(({ show: _show, ...i }) => ({ ...i, active: i.href === '/app' ? path === '/app' : path.startsWith(i.href) }));
}

export function AppShell({ children, theme, initialSession = null }: { children: React.ReactNode; theme: ThemeChoice; initialSession?: SessionInfo | null }) {
  const t = useT();
  const router = useRouter();
  const path = usePathname();
  // Rendered on the server when it could read the session, so the first HTML already has the page.
  const [session, setSession] = React.useState<SessionInfo | null>(initialSession);
  // Admins must complete MFA before using anything but the security page.
  const mfaSetupPending = !!session?.isAdmin && !session.mfaVerified && !path.startsWith('/app/security');

  React.useEffect(() => {
    api<SessionInfo>('/v1/auth/session')
      .then((s) => {
        setSession(s);
        if (s.isAdmin && !s.mfaVerified && !path.startsWith('/app/security')) router.replace('/app/security?setup=1');
      })
      .catch((err) => {
        if (err instanceof ApiProblem && err.status === 401) router.replace(`/signin`);
      });
  }, [path, router]);

  const signOut = async () => {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/signin');
  };

  const nav = session ? navItems(t, session, path) : [];
  const renderLink = (item: NavItem, className: string, children: React.ReactNode) => (
    <Link href={item.href} className={`${className} no-underline`} aria-current={item.active ? 'page' : undefined}>
      {children}
    </Link>
  );

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-dvh">
        <Sidebar>
          <Link href="/app" className="px-3 no-underline">
            <Logo label={t('common.appName')} />
          </Link>
          {session ? <SidebarNav items={nav} label={t('app.nav.label')} renderLink={renderLink} /> : <Skeleton className="h-40" />}
        </Sidebar>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('common.openMenu')}>
                  <Menu aria-hidden className="h-5 w-5 stroke-[1.5]" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" title={t('common.appName')} closeLabel={t('common.closeMenu')}>
                {session ? <SidebarNav items={nav} label={t('app.nav.label')} renderLink={renderLink} /> : null}
              </SheetContent>
            </Sheet>
            <span className="truncate text-callout font-semibold lg:hidden">{t('common.appName')}</span>
            <div className="ml-auto flex items-center gap-3">
              <div className="hidden md:block">
                <LocaleSwitch />
              </div>
              <ThemeSwitch initial={theme} />
              {session ? (
                <span className="hidden max-w-[16ch] truncate text-footnote text-text-secondary sm:inline" title={session.email}>
                  {session.displayName}
                </span>
              ) : null}
              <Button variant="ghost" size="icon" onClick={signOut} aria-label={t('common.signOut')} title={t('common.signOut')}>
                <LogOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Button>
            </div>
          </TopBar>
          <main id="main" className="mx-auto w-full max-w-[var(--app-width)] flex-1 px-4 py-6 md:px-8 md:py-8">
            {session && !mfaSetupPending ? children : <Skeleton className="h-64 w-full" />}
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
