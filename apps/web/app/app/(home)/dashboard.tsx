'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { IntentLink as Link } from '@/components/intent-link';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  FileSignature,
  ListChecks,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Badge, Skeleton, buttonVariants, cn, focusRing } from '@thapsus/ui';
import { compareDates, today as todayIn } from '@thapsus/core/time';
import { numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useIdle } from '@/lib/use-idle';
import { useInView } from '@/lib/use-in-view';
import { dayLong, viewerZone } from '@/lib/week';
import {
  usePeopleInsights,
  useWeekCalendar,
  type ApprovalItem,
  type MeSummary,
  type TaskItem,
} from '@/lib/dashboard-data';
import { IconTile, SectionHeading } from '@/components/dashboard/parts';
import { MeTiles } from '@/components/dashboard/me-tiles';
import { PageTitle, useFeature, useSession } from '../shell';
import { viewerFromSession, visibleActions } from '../workspace';
import type { MoreActionsMenu as MoreActionsMenuType } from './more-actions';

// Below the fold, or behind a click: the charts and the menu primitives load after the page.
const Insights = dynamic(() => import('./insights').then((m) => m.Insights), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});
const loadMoreActions = () => import('./more-actions').then((m) => m.MoreActionsMenu);

/** Quick actions shown as buttons; the rest sit in the "More actions" menu. */
const VISIBLE_ACTIONS = 3;

interface AttentionItem {
  key: string;
  href: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  badge?: React.ReactNode;
}

const sectionLink = cn('inline-flex min-h-8 items-center rounded-sm text-callout', focusRing);

/**
 * Home (ADR-0154): a role-aware dashboard in the BambooHR / Rippling manner. The greeting and quick
 * actions render with the page; then what needs the viewer, their own time and pay, and the team or
 * company insights their permissions allow. Everything comes from existing permission-scoped endpoints.
 */
export interface HomeData {
  summary?: MeSummary;
  approvals?: ApprovalItem[];
  tasks?: TaskItem[];
  onboarding?: { employee: { status: string } };
}

export function HomeDashboard({ initial }: { initial: HomeData }) {
  const t = useT();
  const locale = useLocale();
  const session = useSession()!;
  const n = (v: number) => numberFormat(locale).format(v);

  // Ask HR appears among the quick actions when the workspace and region allow it (as in the shell).
  const ai = useFeature('aiAssistant');
  const askHr = useApi<{ canAsk: boolean }>(ai ? '/v1/ai/status' : null);
  const canAsk = !!askHr.data?.canAsk;
  const viewer = React.useMemo(() => viewerFromSession(session, canAsk), [session, canAsk]);
  const actions = visibleActions(viewer);

  // Today's date comes from the browser's clock after hydration, so the server's clock never shows
  // through (the line keeps its height meanwhile, so nothing moves).
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  // time zone and date computations are slow in the Temporal polyfill: once per mount, not per render
  const zone = React.useMemo(
    () => (mounted ? viewerZone(session.timeZone) : null),
    [mounted, session.timeZone],
  );
  const today = React.useMemo(() => (zone ? todayIn(zone) : null), [zone]);
  const first = session.displayName.split(' ')[0] ?? '';

  const summary = useApi<MeSummary>('/v1/me/summary', initial.summary);
  const approvals = useApi<ApprovalItem[]>('/v1/approvals?view=mine', initial.approvals);
  const tasks = useApi<TaskItem[]>('/v1/tasks?status=open', initial.tasks);
  const onboarding = useApi<{ employee: { status: string } }>(
    session.employeeId ? '/v1/me/onboarding' : null,
    initial.onboarding,
  );

  const showInsights =
    viewer.has('employees.read') && (viewer.has('reports.run') || viewer.has('reports.read_team'));
  const showCalendar = viewer.has('leave.read');
  // the organisation charts and the week calendar sit below "needs your attention" and "you": they
  // load once the browser is idle and the section is close to the screen
  const idle = useIdle();
  const [orgRef, orgInView] = useInView<HTMLElement>();
  const orgReady = idle && orgInView;
  const insights = usePeopleInsights(today, showInsights && orgReady);
  const calendar = useWeekCalendar(today, showCalendar && orgReady);

  // ---- needs your attention ----------------------------------------------------------------------
  const settled = (q: { data?: unknown; error: unknown }) => q.data !== undefined || !!q.error;
  const attentionReady =
    settled(summary) && settled(approvals) && settled(tasks) && (!session.employeeId || settled(onboarding));
  const pending = (approvals.data ?? [])
    .filter((a) => a.status === 'pending')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const openTasks = [...(tasks.data ?? [])].sort((a, b) =>
    a.dueOn && b.dueOn ? compareDates(a.dueOn, b.dueOn) : a.dueOn ? -1 : b.dueOn ? 1 : 0,
  );
  const overdue = summary.data?.tasks.overdue ?? 0;
  const toSign = summary.data?.documents.toSign ?? 0;
  const attention: AttentionItem[] = [];
  if (pending.length)
    attention.push({
      key: 'approvals',
      href: '/app/approvals',
      icon: <ClipboardCheck />,
      label: t('dashboard.attention.approvals', { n: n(pending.length), count: pending.length }),
      hint: pending[0]!.subjectName
        ? t('dashboard.attention.approvalsHint', { name: pending[0]!.subjectName })
        : undefined,
    });
  if (openTasks.length)
    attention.push({
      key: 'tasks',
      href: '/app/tasks',
      icon: <ListChecks />,
      label: t('dashboard.attention.tasks', { n: n(openTasks.length), count: openTasks.length }),
      hint: t('dashboard.attention.tasksHint', { title: openTasks[0]!.title }),
      badge: overdue ? (
        <Badge tone="danger">{t('dashboard.attention.overdue', { n: n(overdue) })}</Badge>
      ) : undefined,
    });
  if (toSign)
    attention.push({
      key: 'documents',
      href: '/app/documents',
      icon: <FileSignature />,
      label: t('dashboard.attention.documents', { n: n(toSign), count: toSign }),
      hint: t('dashboard.attention.documentsHint'),
    });
  if (onboarding.data?.employee.status === 'pre_start')
    attention.push({
      key: 'onboarding',
      href: '/app/welcome',
      icon: <Sparkles />,
      label: t('dashboard.attention.onboarding'),
      hint: t('dashboard.attention.onboardingHint'),
    });
  if (!session.hasMfaFactor)
    attention.push({
      key: 'mfa',
      href: '/app/security',
      icon: <ShieldCheck />,
      label: t('dashboard.attention.mfa'),
      hint: t('dashboard.attention.mfaHint'),
    });

  const s = summary.data;
  const showYou = !!session.employeeId && (!s || !!(s.leave || s.rota || s.clock || s.payslips));
  const showOrg = showInsights || showCalendar;
  const primary = actions.slice(0, VISIBLE_ACTIONS);
  // the menu's code loads when someone points at, touches or activates the stand-in button
  const [MoreActions, setMoreActions] = React.useState<typeof MoreActionsMenuType | null>(null);
  const [moreLoad, setMoreLoad] = React.useState<'no' | 'load' | 'open'>('no');
  const wantMore = moreLoad !== 'no';
  React.useEffect(() => {
    if (!wantMore) return;
    let live = true;
    void loadMoreActions().then((C) => live && setMoreActions(() => C));
    return () => {
      live = false;
    };
  }, [wantMore]);
  const moreIntent = () => setMoreLoad((v) => (v === 'no' ? 'load' : v));
  const more = actions.slice(VISIBLE_ACTIONS);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="min-h-6 text-callout text-text-secondary">{today ? dayLong(today, locale) : null}</p>
          <PageTitle>{t('dashboard.greeting', { name: first })}</PageTitle>
          <p className="mt-1 max-w-[60ch] text-body text-text-secondary">{t('dashboard.intro')}</p>
        </div>
        {actions.length ? (
          <nav aria-label={t('dashboard.quickActions')}>
            <ul className="flex flex-wrap items-center gap-2">
              {primary.map((a) => {
                const Icon = a.icon;
                return (
                  <li key={a.key}>
                    <Link
                      href={a.href}
                      className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'no-underline')}
                    >
                      <Icon aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      {t(a.label)}
                    </Link>
                  </li>
                );
              })}
              {more.length ? (
                <li>
                  {MoreActions ? (
                    <MoreActions actions={more} defaultOpen={moreLoad === 'open'} />
                  ) : (
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={false}
                      className={buttonVariants({ variant: 'secondary', size: 'md' })}
                      onPointerEnter={moreIntent}
                      onTouchStart={moreIntent}
                      onClick={() => setMoreLoad('open')}
                    >
                      {t('dashboard.moreActions')}
                      <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    </button>
                  )}
                </li>
              ) : null}
            </ul>
          </nav>
        ) : null}
      </div>

      <section aria-labelledby="home-attention" className="flex flex-col gap-4">
        <SectionHeading id="home-attention" title={t('dashboard.attention.title')} />
        {!attentionReady ? (
          <Skeleton className="h-20 w-full" />
        ) : attention.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="attention">
            {attention.map((a) => (
              <li key={a.key}>
                <Link
                  href={a.href}
                  className={cn(
                    'flex h-full min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised p-4 text-text no-underline transition-colors duration-[var(--duration-fast)] hover:border-border-strong',
                    focusRing,
                  )}
                >
                  <IconTile>{a.icon}</IconTile>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-callout font-semibold">{a.label}</span>
                    {a.hint ? (
                      <span className="break-words text-footnote text-text-secondary">{a.hint}</span>
                    ) : null}
                  </span>
                  {a.badge}
                  <ChevronRight aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-text-secondary" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div
            className="flex items-center gap-4 rounded-lg border border-border bg-surface-raised p-5"
            data-testid="caught-up"
          >
            <IconTile>
              <CircleCheck />
            </IconTile>
            <div className="min-w-0">
              <p className="text-callout font-semibold text-text">{t('dashboard.attention.caughtUp')}</p>
              <p className="text-footnote text-text-secondary">{t('dashboard.attention.caughtUpBody')}</p>
            </div>
          </div>
        )}
      </section>

      {showYou ? (
        <section aria-labelledby="home-you" className="flex flex-col gap-4">
          <SectionHeading id="home-you" title={t('dashboard.you.title')} />
          {s && today && zone ? (
            <MeTiles summary={s} level={3} today={today} zone={zone} />
          ) : summary.error ? null : (
            <Skeleton className="h-40 w-full" />
          )}
        </section>
      ) : null}

      {showOrg ? (
        <section ref={orgRef} aria-labelledby="home-org" className="flex flex-col gap-4">
          <SectionHeading
            id="home-org"
            title={session.isAdmin ? t('dashboard.org.titleCompany') : t('dashboard.org.titleTeam')}
          >
            {viewer.has('employees.read') ? (
              <Link href="/app/people" className={sectionLink}>
                {t('dashboard.org.directory')}
              </Link>
            ) : null}
            <Link href="/app/org-chart" className={sectionLink}>
              {t('dashboard.org.orgChart')}
            </Link>
            {viewer.has('reports.run') || viewer.has('reports.read_team') ? (
              <Link href="/app/reports" className={sectionLink}>
                {t('dashboard.org.reports')}
              </Link>
            ) : null}
          </SectionHeading>
          {/* rendered once the browser is idle and the section is near the screen: it is below the fold
              on phones, and the heaviest part of the page */}
          {orgReady ? (
            <Insights
              insights={insights.data}
              insightsFailed={insights.failed}
              showInsights={showInsights}
              calendar={calendar.data}
              showCalendar={showCalendar && !calendar.error}
              today={today}
            />
          ) : (
            // a still placeholder (not a pulsing skeleton) while the section waits to be scrolled near
            <div className="h-64 w-full rounded-lg bg-surface-raised" />
          )}
        </section>
      ) : null}
    </div>
  );
}
