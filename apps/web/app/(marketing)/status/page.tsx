import type { Metadata } from 'next';
import { Activity, AlertTriangle, CheckCircle2, Wrench, XCircle } from 'lucide-react';
import { HOME_REGIONS, REGIONS, type HomeRegion } from '@thapsus/core/regions';
import { formatDateTime } from '@thapsus/core/i18n';
import { Badge, Card, Section } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

/**
 * Public status page: each region (UK, EU, US) is reported separately from that cell's own public
 * `/v1/status` endpoint (no personal data; ADR-0105). A region that cannot be reached is shown as such.
 */
export const dynamic = 'force-dynamic';

type State = 'operational' | 'degraded' | 'outage' | 'maintenance';
interface Post {
  id: string;
  kind: string;
  impact: string;
  title: string;
  components: string[];
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string;
  resolvedAt: string | null;
  updates: Array<{ status: string; body: string; createdAt: string }>;
}
interface RegionStatus {
  region: HomeRegion;
  generatedAt: string;
  overall: State;
  components: Array<{ id: string; state: State }>;
  active: Post[];
  upcoming: Post[];
  history: Post[];
}

/** The cell API serving each region: API_URL_<REGION>, or this web app's own cell through the local proxy. */
function statusUrl(region: HomeRegion): string | undefined {
  const base = process.env[`API_URL_${region.toUpperCase()}`] ?? (region === (process.env.CELL_REGION ?? 'uk') ? process.env.API_PROXY_URL : undefined);
  return base ? `${base.replace(/\/$/, '')}/v1/status` : undefined;
}

async function load(region: HomeRegion): Promise<RegionStatus | null> {
  const url = statusUrl(region);
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as RegionStatus;
    return body.region === region ? body : null; // never show one region's status as another's
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('statusPage.meta.title'), description: t('statusPage.meta.description') };
}

const ICON: Record<State, React.ReactNode> = {
  operational: <CheckCircle2 aria-hidden className="h-5 w-5 stroke-[1.5] text-success" />,
  degraded: <AlertTriangle aria-hidden className="h-5 w-5 stroke-[1.5] text-warning" />,
  outage: <XCircle aria-hidden className="h-5 w-5 stroke-[1.5] text-danger" />,
  maintenance: <Wrench aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />,
};
const TONE: Record<State, 'success' | 'warning' | 'danger' | 'accent'> = { operational: 'success', degraded: 'warning', outage: 'danger', maintenance: 'accent' };

export default async function StatusPage() {
  const { t, locale } = await serverContext();
  const results = await Promise.all(HOME_REGIONS.map(async (r) => [r, await load(r)] as const));
  const when = (iso: string, region: HomeRegion) => formatDateTime(iso, locale, REGIONS[region].defaultTimeZone);

  const PostList = ({ posts, region, empty }: { posts: Post[]; region: HomeRegion; empty?: string }) =>
    posts.length ? (
      <ul className="mt-3 flex flex-col gap-4">
        {posts.map((p) => (
          <li key={p.id} className="rounded-md bg-surface p-4">
            <p className="text-callout font-semibold">{p.title}</p>
            <p className="mt-1 text-footnote text-text-secondary">
              {t(`statusPage.postStatus.${p.status}`)} · {p.components.map((c) => t(`statusPage.components.${c}`)).join(', ')}
              {p.kind === 'maintenance' && p.scheduledStart && p.scheduledEnd ? ` · ${when(p.scheduledStart, region)} – ${when(p.scheduledEnd, region)}` : ` · ${when(p.startedAt, region)}`}
            </p>
            <ol className="mt-2 flex flex-col gap-1">
              {p.updates.map((u, i) => (
                <li key={i} className="text-callout text-text">
                  <span className="text-footnote text-text-secondary">{when(u.createdAt, region)} — </span>
                  {u.body}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    ) : empty ? (
      <p className="mt-2 text-callout text-text-secondary">{empty}</p>
    ) : null;

  return (
    <Section tone="bg" className="pt-16 md:pt-24" labelledBy="status-title">
      <div className="flex items-center gap-3">
        <Activity aria-hidden className="h-8 w-8 stroke-[1.5] text-accent" />
        <h1 id="status-title" className="text-title-1">
          {t('statusPage.title')}
        </h1>
      </div>
      <p className="mt-4 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('statusPage.lead')}</p>
      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {results.map(([region, s]) => (
          <section key={region} aria-labelledby={`status-${region}`}>
            <Card className="h-full">
              <h2 id={`status-${region}`} className="text-title-3">
                {t(`regions.${region}`)}
              </h2>
              {s ? (
                <>
                  <p className="mt-3 flex items-center gap-2" data-testid={`overall-${region}`}>
                    {ICON[s.overall]}
                    <Badge tone={TONE[s.overall]}>{t(`statusPage.overall.${s.overall}`)}</Badge>
                  </p>
                  <ul className="mt-5 flex flex-col divide-y divide-border" aria-label={t('statusPage.componentsLabel')}>
                    {s.components.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-callout">
                        <span>{t(`statusPage.components.${c.id}`)}</span>
                        <span className="flex items-center gap-1.5 text-footnote text-text-secondary">
                          {ICON[c.state]}
                          {t(`statusPage.state.${c.state}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <h3 className="mt-6 text-callout font-semibold">{t('statusPage.activeTitle')}</h3>
                  <PostList posts={s.active} region={region} empty={t('statusPage.noActive')} />
                  {s.upcoming.length ? (
                    <>
                      <h3 className="mt-6 text-callout font-semibold">{t('statusPage.upcomingTitle')}</h3>
                      <PostList posts={s.upcoming} region={region} />
                    </>
                  ) : null}
                  <details className="mt-6">
                    <summary className="cursor-pointer text-callout font-semibold text-accent">{t('statusPage.historyTitle', { count: s.history.length })}</summary>
                    <PostList posts={s.history} region={region} empty={t('statusPage.noHistory')} />
                  </details>
                  <p className="mt-6 text-footnote text-text-secondary">{t('statusPage.updated', { time: when(s.generatedAt, region) })}</p>
                </>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-callout text-text-secondary" data-testid={`unavailable-${region}`}>
                  {ICON.degraded}
                  {t('statusPage.unavailable')}
                </p>
              )}
            </Card>
          </section>
        ))}
      </div>
    </Section>
  );
}
