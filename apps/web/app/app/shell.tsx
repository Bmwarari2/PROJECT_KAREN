'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CircleHelp, Menu as MenuIcon, Search } from 'lucide-react';
import {
  Button,
  ModuleHeader,
  Sheet,
  SheetContent,
  SheetTrigger,
  Skeleton,
  TabNav,
  type TabLink,
} from '@thapsus/ui';
import { brandingCss, type BrandPalette } from '@thapsus/ui/branding';
import { FEATURE_FLAGS, type FeatureKey } from '@thapsus/core/features';
import { Logo } from '@/components/logo';
import { GlobalSearch } from '@/components/workspace/global-search';
import { RailNav, RailToggle, useRailCollapsed } from '@/components/workspace/rail';
import { UserMenu } from '@/components/workspace/user-menu';
import { api, ApiProblem, type SessionInfo } from '@/lib/api';
import { syncQueue } from '@/lib/clock-queue';
import { useT } from '@/lib/i18n-client';
import { revealIn } from '@/lib/reveal';
import type { ThemeChoice } from '@/lib/i18n-shared';
import { isTabActive, locate, viewerFromSession, visibleModules } from './workspace';

export const SessionContext = React.createContext<SessionInfo | null>(null);
export const useSession = () => React.useContext(SessionContext);

/** Workspace feature flags and branding (GET /v1/tenant/experience); the app hides disabled features. */
export interface Experience {
  kind: string;
  features: Partial<Record<FeatureKey, boolean>>;
  branding: { palette: { light: BrandPalette; dark: BrandPalette } | null; logoUrl: string | null };
}
export const ExperienceContext = React.createContext<{ experience: Experience | null; reload: () => void }>({
  experience: null,
  reload: () => undefined,
});
export const useExperience = () => React.useContext(ExperienceContext);
/** Whether a feature is on for the signed-in workspace (registry default until the experience loads). */
export function useFeature(key: FeatureKey): boolean {
  const { experience } = useExperience();
  return experience?.features[key] ?? FEATURE_FLAGS[key].default;
}

/**
 * Inside a module the shell renders the module header (the page's h1) and its tab bar, so a page's
 * own title becomes a section heading (`PageTitle` reads this).
 */
export const ModuleFrameContext = React.createContext(false);

/** A page's title: the h1 outside modules, a section heading under a module header. */
export function PageTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  const inModule = React.useContext(ModuleFrameContext);
  return inModule ? (
    <h2 className={className ?? 'text-title-3'}>{children}</h2>
  ) : (
    <h1 className={className ?? 'text-title-2'}>{children}</h1>
  );
}

/**
 * The second factor still has to be used in this session: anyone who has one must verify it, and
 * admins must set one up (the API refuses everything else until then; ASVS V6.3.3).
 */
export function needsSecondFactor(s: SessionInfo | null | undefined): boolean {
  return !!s && !s.mfaVerified && (s.hasMfaFactor || s.isAdmin);
}

/** True when one of the session's grants covers the action (scope is enforced by the API). */
export function hasPermission(s: SessionInfo | null | undefined, p: string): boolean {
  return !!s && viewerFromSession(s).has(p);
}

export function AppShell({
  children,
  theme,
  initialSession = null,
}: {
  children: React.ReactNode;
  theme: ThemeChoice;
  initialSession?: SessionInfo | null;
}) {
  const t = useT();
  const router = useRouter();
  const path = usePathname();
  // Rendered on the server when it could read the session, so the first HTML already has the page.
  const [session, setSession] = React.useState<SessionInfo | null>(initialSession);
  // A second factor must be verified (or, for admins, set up) before anything but the security page.
  const mfaSetupPending = needsSecondFactor(session) && !path.startsWith('/app/security');
  const [experience, setExperience] = React.useState<Experience | null>(null);
  const [experienceTick, setExperienceTick] = React.useState(0);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [collapsed, setCollapsed] = useRailCollapsed();
  // the shortcut hint names the key the viewer's keyboard has (set after hydration)
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);

  React.useEffect(() => {
    api<SessionInfo>('/v1/auth/session')
      .then((s) => {
        setSession(s);
        if (needsSecondFactor(s) && !path.startsWith('/app/security'))
          router.replace(s.hasMfaFactor ? '/app/security?verify=1' : '/app/security?setup=1');
      })
      .catch((err) => {
        if (err instanceof ApiProblem && err.status === 401) router.replace(`/signin`);
      });
  }, [path, router]);

  const ready = !!session && !needsSecondFactor(session);
  React.useEffect(() => {
    if (!ready) return;
    api<Experience>('/v1/tenant/experience')
      .then(setExperience)
      .catch(() => undefined);
  }, [ready, experienceTick]);
  const experienceValue = React.useMemo(
    () => ({ experience, reload: () => setExperienceTick((n) => n + 1) }),
    [experience],
  );

  // Ask HR needs the platform flag, the region and the customer's opt-in; the API resolves all three.
  const [askHr, setAskHr] = React.useState(false);
  const aiFlag = !!experience?.features.aiAssistant;
  React.useEffect(() => {
    if (!aiFlag) return setAskHr(false);
    api<{ canAsk: boolean }>('/v1/ai/status')
      .then((s) => setAskHr(s.canAsk))
      .catch(() => setAskHr(false));
  }, [aiFlag, experienceTick, path]);

  // Counts on the rail, the inbox tabs and the bell: pending approvals, open tasks, unread notifications.
  const [counts, setCounts] = React.useState({ approvals: 0, tasks: 0, unread: 0 });
  React.useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    Promise.all([
      api<Array<{ status: string }>>('/v1/approvals?view=mine').catch(() => []),
      api<unknown[]>('/v1/tasks?status=open').catch(() => []),
      api<{ unread: number }>('/v1/me/notifications?limit=1').catch(() => ({ unread: 0 })),
    ]).then(([a, tk, n]) => {
      if (!cancelled)
        setCounts({
          approvals: a.filter((x) => x.status === 'pending').length,
          tasks: tk.length,
          unread: n.unread,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, path]);

  // Ctrl/⌘ K opens search anywhere; "/" does too when the focus is not in a field.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The rail scrolls on its own: keep the current entry in view (it may sit below the fold).
  React.useEffect(() => {
    const link = document.querySelector<HTMLElement>('#app-rail a[aria-current="page"]');
    revealIn(document.getElementById('app-rail'), link);
  }, [path, session]);

  // Signing out sends any offline clock punches first, ends the session (the API answers with
  // Clear-Site-Data) and reloads the page so nothing from the session stays in memory (ASVS V14.3.1).
  const signOut = async () => {
    if (session) await syncQueue(session.userId).catch(() => undefined);
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.replace('/signin');
  };

  const viewer = React.useMemo(() => (session ? viewerFromSession(session, askHr) : null), [session, askHr]);
  const modules = React.useMemo(() => (viewer ? visibleModules(viewer) : []), [viewer]);
  const here = locate(modules, path);
  const current = here?.module ?? null;
  const railCounts = { inbox: counts.approvals + counts.tasks };
  const tabCounts: Record<string, number> = {
    '/app/approvals': counts.approvals,
    '/app/tasks': counts.tasks,
  };
  // The module header and tab bar frame every module page except Home, which is its own dashboard.
  const framed = !!current && current.key !== 'home' && !mfaSetupPending;
  const tabs: TabLink[] =
    framed && current.tabs.length > 1
      ? current.tabs.map((tab) => ({
          href: tab.href,
          label: t(tab.label),
          active: here?.tab?.href === tab.href || (!here?.tab && isTabActive(tab, path)),
          count: tabCounts[tab.href],
        }))
      : [];
  const renderTab = (tab: TabLink, className: string, kids: React.ReactNode) => (
    <Link href={tab.href} className={className} aria-current={tab.active ? 'page' : undefined}>
      {kids}
    </Link>
  );
  const CurrentIcon = current?.icon;

  return (
    <SessionContext.Provider value={session}>
      <ExperienceContext.Provider value={experienceValue}>
        {experience?.branding.palette ? <style>{brandingCss(experience.branding.palette)}</style> : null}
        <div className="flex min-h-dvh flex-col bg-surface">
          <header className="sticky top-0 z-40 flex h-[var(--topbar-height)] items-center gap-2 bg-chrome px-3 text-on-chrome md:gap-4 md:px-4">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-on-chrome hover:bg-chrome-raised focus-visible:outline-chrome-focus lg:hidden"
                  aria-label={t('common.openMenu')}
                >
                  <MenuIcon aria-hidden className="h-5 w-5 stroke-[1.5]" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" title={t('common.appName')} closeLabel={t('common.closeMenu')}>
                {session ? (
                  <RailNav
                    modules={modules}
                    currentKey={current?.key ?? null}
                    counts={railCounts}
                    onNavigate={() => setMenuOpen(false)}
                  />
                ) : null}
              </SheetContent>
            </Sheet>
            <Link
              href="/app"
              className="flex shrink-0 items-center rounded-md px-1 text-on-chrome no-underline focus-visible:outline-2 focus-visible:outline-chrome-focus"
            >
              {experience?.branding.logoUrl ? (
                <img
                  src={experience.branding.logoUrl}
                  alt={t('platform.branding.logoAlt')}
                  className="h-8 max-w-[140px] object-contain"
                />
              ) : (
                <Logo label={t('common.appName')} className="!text-on-chrome [&_svg]:!text-chrome-focus" />
              )}
            </Link>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              disabled={!ready}
              aria-label={t('app.ws.search.open')}
              aria-keyshortcuts="Control+K Meta+K"
              className="ml-auto flex h-10 min-w-10 items-center justify-center gap-2 rounded-md bg-chrome-raised px-2.5 text-left text-callout text-on-chrome-secondary hover:text-on-chrome focus-visible:outline-2 focus-visible:outline-chrome-focus disabled:opacity-60 sm:ml-2 sm:max-w-[560px] sm:flex-1 sm:justify-start sm:px-3"
            >
              <Search aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5]" />
              <span className="hidden truncate sm:inline">{t('app.ws.search.placeholder')}</span>
              <kbd className="ml-auto hidden rounded border border-on-chrome-secondary px-1.5 text-footnote md:inline">
                {mac ? t('app.ws.search.shortcutMac') : t('app.ws.search.shortcut')}
              </kbd>
            </button>
            <div className="flex items-center gap-1 sm:ml-auto">
              {/* Contextual help: articles linked from the page the user is on. */}
              <Link
                href={`/app/help?context=${encodeURIComponent(path)}`}
                className="hidden h-10 w-10 items-center justify-center rounded-md text-on-chrome hover:bg-chrome-raised focus-visible:outline-2 focus-visible:outline-chrome-focus sm:inline-flex"
                aria-label={t('app.nav.helpForPage')}
                title={t('app.nav.helpForPage')}
              >
                <CircleHelp aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Link>
              <Link
                href="/app/notifications"
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-md text-on-chrome hover:bg-chrome-raised focus-visible:outline-2 focus-visible:outline-chrome-focus"
                aria-label={
                  counts.unread
                    ? t('app.ws.notificationsUnread', { count: counts.unread })
                    : t('app.nav.notifications')
                }
                title={t('app.nav.notifications')}
              >
                <Bell aria-hidden className="h-5 w-5 stroke-[1.5]" />
                {counts.unread ? (
                  <span
                    aria-hidden
                    className="absolute right-1 top-1 min-w-[18px] rounded-full bg-chrome-focus px-1 text-center text-footnote font-semibold leading-[18px] text-chrome"
                  >
                    {counts.unread > 9 ? '9+' : counts.unread}
                  </span>
                ) : null}
              </Link>
              {session ? <UserMenu session={session} theme={theme} onSignOut={signOut} /> : null}
            </div>
          </header>
          <div className="flex flex-1">
            <aside
              id="app-rail"
              className={`sticky top-[var(--topbar-height)] hidden h-[calc(100dvh-var(--topbar-height))] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface-raised p-3 [scroll-padding-block:12px] lg:flex ${collapsed ? 'w-[var(--rail-collapsed-width)]' : 'w-[var(--sidebar-width)]'}`}
            >
              {session ? (
                <RailNav
                  modules={modules}
                  currentKey={current?.key ?? null}
                  collapsed={collapsed}
                  counts={railCounts}
                />
              ) : (
                <Skeleton className="h-40" />
              )}
              <div className="mt-auto">
                <RailToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
              </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              {experience?.kind === 'sandbox' ? (
                <p
                  role="status"
                  className="border-b border-border bg-accent-subtle px-4 py-2 text-center text-footnote text-text"
                >
                  {t('platform.sandbox.banner')}
                </p>
              ) : null}
              {framed && CurrentIcon ? (
                <ModuleHeader
                  icon={<CurrentIcon aria-hidden />}
                  title={t(current.label)}
                  tabs={
                    tabs.length ? (
                      <TabNav
                        tabs={tabs}
                        label={t('app.ws.sections', { module: t(current.label) })}
                        renderLink={renderTab}
                      />
                    ) : undefined
                  }
                />
              ) : null}
              <main
                id="main"
                className="mx-auto w-full max-w-[var(--app-width)] flex-1 px-4 py-6 md:px-8 md:py-8"
              >
                <ModuleFrameContext.Provider value={framed}>
                  {session && !mfaSetupPending ? children : <Skeleton className="h-64 w-full" />}
                </ModuleFrameContext.Provider>
              </main>
            </div>
          </div>
        </div>
        {session && viewer ? (
          <GlobalSearch
            open={searchOpen}
            onOpenChange={setSearchOpen}
            viewer={viewer}
            userId={session.userId}
          />
        ) : null}
      </ExperienceContext.Provider>
    </SessionContext.Provider>
  );
}
