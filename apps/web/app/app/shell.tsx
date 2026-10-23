'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BarChart3, Bell, CalendarClock, CalendarDays, CircleHelp, ClipboardList, Clock, CreditCard, DoorOpen, FileText, Home, Inbox, Laptop, LifeBuoy, ListChecks, Lock, LogOut, Menu, MessageCircleQuestionMark, Network, Plug, Receipt, Scale, Settings, ShieldCheck, Upload, UserRound, Users, Wallet, Zap } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetTrigger, Sidebar, SidebarNav, Skeleton, TopBar, type NavItem } from '@thapsus/ui';
import { brandingCss, type BrandPalette } from '@thapsus/ui/branding';
import { FEATURE_FLAGS, type FeatureKey } from '@thapsus/core/features';
import { Logo } from '@/components/logo';
import { LocaleSwitch, ThemeSwitch } from '@/components/client';
import { api, ApiProblem, type SessionInfo } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import type { ThemeChoice } from '@/lib/i18n-shared';
import { visibleSections } from './settings/sections';

export const SessionContext = React.createContext<SessionInfo | null>(null);
export const useSession = () => React.useContext(SessionContext);

/** Workspace feature flags and branding (GET /v1/tenant/experience); the app hides disabled features. */
export interface Experience {
  kind: string;
  features: Partial<Record<FeatureKey, boolean>>;
  branding: { palette: { light: BrandPalette; dark: BrandPalette } | null; logoUrl: string | null };
}
export const ExperienceContext = React.createContext<{ experience: Experience | null; reload: () => void }>({ experience: null, reload: () => undefined });
export const useExperience = () => React.useContext(ExperienceContext);
/** Whether a feature is on for the signed-in workspace (registry default until the experience loads). */
export function useFeature(key: FeatureKey): boolean {
  const { experience } = useExperience();
  return experience?.features[key] ?? FEATURE_FLAGS[key].default;
}

/** True when one of the session's grants covers the action (scope is enforced by the API). */
export function hasPermission(s: SessionInfo | null | undefined, p: string): boolean {
  return !!s?.permissions.some((g) => g === '*' || g === p || (g.endsWith('.*') && p.startsWith(g.slice(0, -1))));
}

/** Navigation entries; each feature phase adds its own (permission-filtered). `askHr`: Ask HR is on for this user. */
export function navItems(t: (k: string) => string, s: SessionInfo, path: string, opts: { askHr?: boolean } = {}): NavItem[] {
  const has = (p: string) => hasPermission(s, p);
  const items: Array<NavItem & { show: boolean }> = [
    { href: '/app', label: t('app.nav.home'), icon: <Home aria-hidden />, show: true },
    { href: '/app/me', label: t('app.nav.me'), icon: <UserRound aria-hidden />, show: !!s.employeeId },
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
    { href: '/app/ask', label: t('app.nav.askHr'), icon: <MessageCircleQuestionMark aria-hidden />, show: !!opts.askHr },
    { href: '/app/payslips', label: t('app.nav.payslips'), icon: <Receipt aria-hidden />, show: has('payslips.read_own') || has('payslips.manage') },
    { href: '/app/assets', label: t('app.nav.assets'), icon: <Laptop aria-hidden />, show: has('assets.read_own') || has('assets.read') },
    { href: '/app/payroll', label: t('app.nav.payroll'), icon: <Wallet aria-hidden />, show: has('payroll.read') },
    { href: '/app/integrations', label: t('app.nav.integrations'), icon: <Plug aria-hidden />, show: has('integrations.read') },
    { href: '/app/compliance', label: t('app.nav.compliance'), icon: <Scale aria-hidden />, show: has('compliance.read') || has('compliance.law_changes') },
    { href: '/app/reports', label: t('app.nav.reports'), icon: <BarChart3 aria-hidden />, show: has('reports.run') || has('reports.read_team') },
    { href: '/app/imports', label: t('app.nav.imports'), icon: <Upload aria-hidden />, show: has('imports.run') },
    { href: '/app/automation', label: t('app.nav.automation'), icon: <Zap aria-hidden />, show: has('automation.read') },
    { href: '/app/privacy', label: t('app.nav.privacy'), icon: <Lock aria-hidden />, show: has('privacy.read') },
    { href: '/app/notifications', label: t('app.nav.notifications'), icon: <Bell aria-hidden />, show: true },
    { href: '/app/security', label: t('app.nav.security'), icon: <ShieldCheck aria-hidden />, show: true },
    // Shown when the user may open at least one settings section (the settings area filters each one).
    { href: '/app/settings', label: t('app.nav.settings'), icon: <Settings aria-hidden />, show: has('settings.read') || visibleSections(has).length > 0 },
    { href: '/app/billing', label: t('app.nav.billing'), icon: <CreditCard aria-hidden />, show: has('billing.manage') },
    { href: '/app/help', label: t('app.nav.help'), icon: <CircleHelp aria-hidden />, show: true },
    { href: '/app/support', label: t('app.nav.support'), icon: <LifeBuoy aria-hidden />, show: has('support.ticket') },
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
  const [experience, setExperience] = React.useState<Experience | null>(null);
  const [experienceTick, setExperienceTick] = React.useState(0);

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

  React.useEffect(() => {
    if (!session || (session.isAdmin && !session.mfaVerified)) return;
    api<Experience>('/v1/tenant/experience')
      .then(setExperience)
      .catch(() => undefined);
  }, [session, experienceTick]);
  const experienceValue = React.useMemo(() => ({ experience, reload: () => setExperienceTick((n) => n + 1) }), [experience]);

  // Ask HR needs the platform flag, the region and the customer's opt-in; the API resolves all three.
  const [askHr, setAskHr] = React.useState(false);
  const aiFlag = !!experience?.features.aiAssistant;
  React.useEffect(() => {
    if (!aiFlag) return setAskHr(false);
    api<{ canAsk: boolean }>('/v1/ai/status')
      .then((s) => setAskHr(s.canAsk))
      .catch(() => setAskHr(false));
  }, [aiFlag, experienceTick, path]);

  // The sidebar scrolls on its own: keep the current entry in view (it may sit below the fold).
  React.useEffect(() => {
    document.querySelector<HTMLElement>('aside nav a[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [path, session]);

  const signOut = async () => {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/signin');
  };

  const nav = session ? navItems(t, session, path, { askHr }) : [];
  const renderLink = (item: NavItem, className: string, children: React.ReactNode) => (
    <Link href={item.href} className={`${className} no-underline`} aria-current={item.active ? 'page' : undefined}>
      {children}
    </Link>
  );

  return (
    <SessionContext.Provider value={session}>
      <ExperienceContext.Provider value={experienceValue}>
      {experience?.branding.palette ? <style>{brandingCss(experience.branding.palette)}</style> : null}
      <div className="flex min-h-dvh">
        <Sidebar>
          <Link href="/app" className="px-3 no-underline">
            {experience?.branding.logoUrl ? (
              <img src={experience.branding.logoUrl} alt={t('platform.branding.logoAlt')} className="h-8 max-w-[160px] object-contain" />
            ) : (
              <Logo label={t('common.appName')} />
            )}
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
              {/* Contextual help: articles linked from the page the user is on. */}
              <Link href={`/app/help?context=${encodeURIComponent(path)}`} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text hover:bg-surface" aria-label={t('app.nav.helpForPage')} title={t('app.nav.helpForPage')}>
                <CircleHelp aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Link>
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
          {experience?.kind === 'sandbox' ? (
            <p role="status" className="border-b border-border bg-accent-subtle px-4 py-2 text-center text-footnote text-text">
              {t('platform.sandbox.banner')}
            </p>
          ) : null}
          <main id="main" className="mx-auto w-full max-w-[var(--app-width)] flex-1 px-4 py-6 md:px-8 md:py-8">
            {session && !mfaSetupPending ? children : <Skeleton className="h-64 w-full" />}
          </main>
        </div>
      </div>
      </ExperienceContext.Provider>
    </SessionContext.Provider>
  );
}
