'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive, FilePlus2, FileText, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  EmptyState,
  ListItem,
  ListSection,
  Skeleton,
  useToast,
} from '@thapsus/ui';
import { formatDate, regionName } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';
import { PageHeader, ReadOnlyNote, usePermission } from '../../kit';

export interface TemplateSummary {
  id: string;
  name: string;
  locale: string;
  category: string;
  requiresCountersign: boolean;
  status: string;
  version: number;
  sampleKey: string | null;
  signingOrder: string;
  askFields: Array<{ key: string; label: string; required: boolean }>;
  updatedAt: string | null;
}
interface Sample {
  key: string;
  country: string;
  name: string;
  category: string;
  locale: string;
  templateId: string | null;
}

/**
 * Settings → Documents → Templates (16.9, ADR-0194): the workspace's templates, the archived ones, and the starter
 * samples for the UK, Ireland and the US, which are copied in on request and stay labelled as samples until the
 * customer's own adviser has reviewed their wording.
 */
export default function TemplatesPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const has = usePermission();
  const canManage = has('documents.manage');
  const list = useApi<TemplateSummary[]>(canManage ? '/v1/document-templates?status=all' : null);
  const samples = useApi<Sample[]>(canManage ? '/v1/document-templates/samples' : null);
  const [adding, setAdding] = React.useState<string | null>(null);
  if (!canManage) return <ReadOnlyNote />;
  const active = (list.data ?? []).filter((x) => x.status === 'active');
  const archived = (list.data ?? []).filter((x) => x.status === 'archived');
  const subtitle = (x: TemplateSummary) =>
    [
      t(`documents.categoryName.${x.category}`) === `documents.categoryName.${x.category}`
        ? x.category
        : t(`documents.categoryName.${x.category}`),
      t('docTpl.versionShort', { version: x.version }),
      x.updatedAt ? t('docTpl.updatedOn', { date: formatDate(x.updatedAt.slice(0, 10), locale) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const badges = (x: TemplateSummary) => (
    <span className="flex flex-wrap gap-1">
      {x.sampleKey ? <Badge tone="warning">{t('docTpl.sample')}</Badge> : null}
      {x.requiresCountersign ? <Badge>{t('docTpl.companySigns')}</Badge> : null}
    </span>
  );

  async function addSample(key: string) {
    setAdding(key);
    try {
      const r = await api<{ id: string }>(`/v1/document-templates/samples/${key}`, { method: 'POST' });
      toast({ title: t('docTpl.sampleAdded'), tone: 'success' });
      router.push(`/app/settings/documents/templates/${r.id}`);
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.section.documentTemplates.title')} lead={t('docTpl.lead')}>
        <IntentLink
          href="/app/settings/documents/templates/new"
          className={buttonVariants({ variant: 'primary' }) + ' min-h-11 no-underline'}
        >
          <FilePlus2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('docTpl.new')}
        </IntentLink>
      </PageHeader>
      {!list.data ? (
        <Skeleton className="h-40 w-full" />
      ) : active.length ? (
        <ListSection title={t('docTpl.active')} id="templates-active">
          {active.map((x) => (
            <ListItem
              key={x.id}
              href={`/app/settings/documents/templates/${x.id}`}
              linkAs={IntentLink}
              leading={<FileText />}
              title={<span className="wrap-anywhere">{x.name}</span>}
              subtitle={subtitle(x)}
              meta={badges(x)}
            />
          ))}
        </ListSection>
      ) : (
        <EmptyState level={2} icon={<FileText aria-hidden />} title={t('docTpl.empty')} />
      )}
      <ListSection
        title={t('docTpl.samplesTitle')}
        description={t('docTpl.samplesLead')}
        id="templates-samples"
      >
        {(samples.data ?? []).map((s) => (
          <ListItem
            key={s.key}
            leading={<Sparkles />}
            href={s.templateId ? `/app/settings/documents/templates/${s.templateId}` : undefined}
            linkAs={IntentLink}
            title={<span className="wrap-anywhere">{s.name}</span>}
            subtitle={`${regionName(s.country, locale)} · ${t('docTpl.sampleNote')}`}
            meta={<Badge tone="warning">{t('docTpl.sample')}</Badge>}
            actions={
              s.templateId ? undefined : (
                <Button
                  variant="secondary"
                  className="min-h-11"
                  loading={adding === s.key}
                  aria-label={t('docTpl.addSampleNamed', { name: s.name })}
                  onClick={() => addSample(s.key)}
                >
                  {t('docTpl.addSample')}
                </Button>
              )
            }
          />
        ))}
      </ListSection>
      {archived.length ? (
        <ListSection title={t('docTpl.archived')} id="templates-archived">
          {archived.map((x) => (
            <ListItem
              key={x.id}
              href={`/app/settings/documents/templates/${x.id}`}
              linkAs={IntentLink}
              leading={<Archive />}
              title={<span className="wrap-anywhere">{x.name}</span>}
              subtitle={subtitle(x)}
            />
          ))}
        </ListSection>
      ) : null}
    </div>
  );
}
