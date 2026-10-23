'use client';
import * as React from 'react';
import Link from 'next/link';
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
import {
  Badge,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  buttonVariants,
  cn,
  focusRing,
} from '@thapsus/ui';
import { compareDates, today as todayIn } from '@thapsus/core/time';
import { numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
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
import { Insights } from './insights';

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
export default function HomePage() {
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
  const zone = mounted ? viewerZone(session.timeZone) : null;
  const today = zone ? todayIn(zone) : null;
  const first = session.displayName.split(' ')[0] ?? '';

  const summary = useApi<MeSummary>('/v1/me/summary');
  const approvals = useApi<ApprovalItem[]>('/v1/approvals?view=mine');
  const tasks = useApi<TaskItem[]>('/v1/tasks?status=open');
  const onboarding = useApi<{ employee: { status: string } }>(
    session.employeeId ? '/v1/me/onboarding' : null,
  );

  const showInsights =
    viewer.has('employees.read') && (viewer.has('reports.run') || viewer.has('reports.read_team'));
  const showCalendar = viewer.has('leave.read');
  const insights = usePeopleInsights(today, showInsights);
  const calendar = useWeekCalendar(today, showCalendar);

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
  const more = actions.slice(VISIBLE_ACTIONS);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="min-h-6 text-callout text-text-secondary">{today ? dayLong(today, locale) : null}</p>
          <PageTitle>{t('dashboard.greeting', { name: first })}</PageTitle>
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
                  <Menu>
                    <MenuTrigger className={buttonVariants({ variant: 'secondary', size: 'md' })}>
                      {t('dashboard.moreActions')}
                      <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    </MenuTrigger>
                    <MenuContent>
                      {more.map((a) => {
                        const Icon = a.icon;
                        return (
                          <MenuItem key={a.key} asChild>
                            <Link href={a.href} className="text-text no-underline">
                              <Icon aria-hidden />
                              {t(a.label)}
                            </Link>
                          </MenuItem>
                        );
                      })}
                    </MenuContent>
                  </Menu>
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
        <section aria-labelledby="home-org" className="flex flex-col gap-4">
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
          <Insights
            insights={insights.data}
            insightsFailed={insights.failed}
            showInsights={showInsights}
            calendar={calendar.data}
            showCalendar={showCalendar && !calendar.error}
            today={today}
          />
        </section>
      ) : null}
    </div>
  );
}
