'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BookCheck,
  Building2,
  CreditCard,
  Gauge,
  LifeBuoy,
  LogOut,
  Menu,
  Newspaper,
  ScrollText,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetTrigger,
  Sidebar,
  SidebarNav,
  Skeleton,
  TopBar,
  type NavItem,
} from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { LocaleSwitch, ThemeSwitch } from '@/components/client';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import type { ThemeChoice } from '@/lib/i18n';
import { StaffContext, staffCan, type StaffSession } from './ui';

/**
 * Back-office navigation. Screens built on other phases' APIs plug in here: the law-changes feed
 * (phase 5) is integrated; feature flags (phase 9) live on each tenant's page.
 */
function navItems(t: (k: string) => string, s: StaffSession, path: string): NavItem[] {
  const items: Array<NavItem & { show: boolean }> = [
    { href: '/backoffice', label: t('backoffice.nav.overview'), icon: <Gauge aria-hidden />, show: true },
    {
      href: '/backoffice/tenants',
      label: t('backoffice.nav.tenants'),
      icon: <Building2 aria-hidden />,
      show: staffCan(s, 'support', 'billing'),
    },
    {
      href: '/backoffice/support',
      label: t('backoffice.nav.support'),
      icon: <LifeBuoy aria-hidden />,
      show: staffCan(s, 'support'),
    },
    {
      href: '/backoffice/plans',
      label: t('backoffice.nav.plans'),
      icon: <CreditCard aria-hidden />,
      show: staffCan(s, 'billing'),
    },
    {
      href: '/backoffice/status',
      label: t('backoffice.nav.status'),
      icon: <Activity aria-hidden />,
      show: staffCan(s, 'support'),
    },
    {
      href: '/backoffice/rules',
      label: t('backoffice.nav.rules'),
      icon: <BookCheck aria-hidden />,
      show: staffCan(s, 'rules_editor'),
    },
    {
      href: '/backoffice/law-changes',
      label: t('backoffice.nav.lawChanges'),
      icon: <Newspaper aria-hidden />,
      show: staffCan(s, 'rules_editor', 'support'),
    },
    {
      href: '/backoffice/access',
      label: t('backoffice.nav.access'),
      icon: <ShieldCheck aria-hidden />,
      show: true,
    },
    {
      href: '/backoffice/audit',
      label: t('backoffice.nav.audit'),
      icon: <ScrollText aria-hidden />,
      show: staffCan(s),
    },
    {
      href: '/backoffice/settings',
      label: t('backoffice.nav.settings'),
      icon: <Settings2 aria-hidden />,
      show: staffCan(s, 'support'),
    },
  ];
  return items
    .filter((i) => i.show)
    .map(({ show: _show, ...i }) => ({
      ...i,
      active: i.href === '/backoffice' ? path === '/backoffice' : path.startsWith(i.href),
    }));
}

export function BackofficeShell({ children, theme }: { children: React.ReactNode; theme: ThemeChoice }) {
  const t = useT();
  const router = useRouter();
  const path = usePathname();
  // signing in and the one-time enrolment link have no shell (nobody is signed in yet)
  const signin = path.startsWith('/backoffice/signin') || path.startsWith('/backoffice/enrol');
  const [staff, setStaff] = React.useState<StaffSession | null>(null);

  React.useEffect(() => {
    if (signin) return;
    api<StaffSession>('/v1/backoffice/auth/session')
      .then(setStaff)
      .catch((err) => {
        if (err instanceof ApiProblem && (err.status === 401 || err.status === 403))
          router.replace('/backoffice/signin');
      });
  }, [signin, router, path]);

  if (signin)
    return (
      <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        {children}
      </main>
    );

  const nav = staff ? navItems(t, staff, path) : [];
  const renderLink = (item: NavItem, className: string, content: React.ReactNode) => (
    <Link
      href={item.href}
      className={`${className} no-underline`}
      aria-current={item.active ? 'page' : undefined}
    >
      {content}
    </Link>
  );
  const signOut = async () => {
    await api('/v1/backoffice/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/backoffice/signin');
  };

  return (
    <StaffContext.Provider value={staff}>
      <div className="flex min-h-dvh">
        <Sidebar>
          <Link href="/backoffice" className="flex items-center gap-2 px-3 no-underline">
            <Logo label={t('common.appName')} />
          </Link>
          <p className="px-3 text-footnote text-text-secondary">{t('backoffice.title')}</p>
          {staff ? (
            <SidebarNav items={nav} label={t('backoffice.nav.label')} renderLink={renderLink} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Sidebar>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('common.openMenu')}>
                  <Menu aria-hidden className="h-5 w-5 stroke-[1.5]" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" title={t('backoffice.title')} closeLabel={t('common.closeMenu')}>
                {staff ? (
                  <SidebarNav items={nav} label={t('backoffice.nav.label')} renderLink={renderLink} />
                ) : null}
              </SheetContent>
            </Sheet>
            {staff ? (
              <Badge tone="accent">{t('backoffice.cell', { region: t(`regions.${staff.cell}`) })}</Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-3">
              <div className="hidden md:block">
                <LocaleSwitch />
              </div>
              <ThemeSwitch initial={theme} />
              {staff ? (
                <span
                  className="hidden max-w-[20ch] truncate text-footnote text-text-secondary sm:inline"
                  title={staff.email}
                >
                  {staff.displayName} · {t(`backoffice.roles.${staff.role}`)}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                onClick={signOut}
                aria-label={t('common.signOut')}
                title={t('common.signOut')}
              >
                <LogOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Button>
            </div>
          </TopBar>
          <main
            id="main"
            className="mx-auto w-full max-w-[var(--app-width)] flex-1 px-4 py-6 md:px-8 md:py-8"
          >
            {staff?.role === 'super_admin' &&
            !staff.elevations?.some((e) => e.scope === 'super_admin') &&
            !path.startsWith('/backoffice/access') ? (
              <div
                role="status"
                className="mb-6 flex flex-col gap-3 rounded-lg bg-surface-raised p-4 shadow-sm sm:flex-row sm:items-center"
              >
                <p className="min-w-0 flex-1 text-callout">{t('backoffice.elevation.banner')}</p>
                <Link
                  href="/backoffice/access"
                  className="inline-flex h-11 shrink-0 items-center justify-center self-start rounded-pill border border-border px-5 text-callout font-semibold text-text no-underline hover:bg-surface sm:h-10 sm:self-auto"
                >
                  {t('backoffice.elevation.openAccess')}
                </Link>
              </div>
            ) : null}
            {staff ? children : <Skeleton className="h-64 w-full" />}
          </main>
        </div>
      </div>
    </StaffContext.Provider>
  );
}
