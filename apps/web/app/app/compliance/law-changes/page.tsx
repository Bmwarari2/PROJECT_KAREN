'use client';
import * as React from 'react';
import { CheckCircle2, Landmark } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Skeleton, useToast } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { SourceLink } from '../ui';

interface Item {
  id: string;
  jurisdiction: string;
  effectiveDate: string;
  title: string;
  summary: string;
  whatToDo: string;
  sourceUrl: string | null;
  ruleVersions: Array<{ jurisdiction: string; key: string; effectiveFrom: string; source: { url: string; title: string }; verifiedOn: string }>;
  readAt: string | null;
  acknowledgedAt: string | null;
  acknowledgements: Array<{ userId: string; displayName: string; acknowledgedAt: string }>;
}

export default function LawChangesPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [onlyOpen, setOnlyOpen] = React.useState(false);
  const feed = useApi<{ jurisdictions: string[]; items: Item[] }>(`/v1/compliance/law-changes${onlyOpen ? '?unacknowledgedOnly=true' : ''}`);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function acknowledge(id: string) {
    setBusy(id);
    try {
      await api(`/v1/compliance/law-changes/${id}/acknowledge`, { method: 'POST' });
      toast({ title: t('compliance.law.acknowledgedToast'), tone: 'success' });
      feed.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-2">{t('compliance.law.title')}</h1>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('compliance.law.intro')}</p>
      {feed.data ? <p className="text-footnote text-text-secondary">{t('compliance.law.jurisdictions', { codes: feed.data.jurisdictions.join(', ') || t('common.none') })}</p> : null}
      <label className="flex items-center gap-3 text-callout">
        <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="accent-[var(--color-accent)]" />
        {t('compliance.law.onlyOpen')}
      </label>
      {!feed.data ? (
        feed.error ? <EmptyState title={t('compliance.noAccess')} /> : <Skeleton className="h-40 w-full" />
      ) : feed.data.items.length === 0 ? (
        <EmptyState icon={<Landmark aria-hidden />} title={t('compliance.law.empty')} />
      ) : (
        <ul className="flex flex-col gap-4" aria-label={t('compliance.law.listLabel')}>
          {feed.data.items.map((i) => (
            <li key={i.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{i.jurisdiction}</Badge>
                  <span className="text-footnote text-text-secondary">{t('compliance.law.effective', { date: formatDate(i.effectiveDate, locale) })}</span>
                  {i.acknowledgedAt ? (
                    <Badge tone="success" className="ml-auto">
                      <CheckCircle2 aria-hidden className="h-3.5 w-3.5 stroke-[1.5]" />
                      {t('compliance.law.acknowledged', { date: formatDate(i.acknowledgedAt.slice(0, 10), locale) })}
                    </Badge>
                  ) : null}
                </div>
                <CardTitle>{i.title}</CardTitle>
                <p className="text-callout">{i.summary}</p>
                <div>
                  <h4 className="text-callout font-semibold">{t('compliance.law.whatToDo')}</h4>
                  <p className="text-callout">{i.whatToDo}</p>
                </div>
                {i.ruleVersions.length ? (
                  <div>
                    <h4 className="text-footnote font-semibold text-text-secondary">{t('compliance.law.rules')}</h4>
                    {i.ruleVersions.map((v) => (
                      <SourceLink key={`${v.jurisdiction}:${v.key}:${v.effectiveFrom}`} source={{ url: v.source.url, title: `${v.jurisdiction} · ${v.key} · ${formatDate(v.effectiveFrom, locale)}` }} verifiedOn={v.verifiedOn} />
                    ))}
                  </div>
                ) : null}
                {i.sourceUrl ? <SourceLink source={{ url: i.sourceUrl, title: i.sourceUrl }} /> : null}
                {i.acknowledgements.length ? <p className="text-footnote text-text-secondary">{t('compliance.law.ackBy', { names: i.acknowledgements.map((a) => a.displayName).join(', ') })}</p> : null}
                {!i.acknowledgedAt ? (
                  <div>
                    <Button size="sm" onClick={() => acknowledge(i.id)} loading={busy === i.id} aria-label={t('compliance.law.acknowledgeItem', { title: i.title })}>
                      {t('compliance.law.acknowledge')}
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
