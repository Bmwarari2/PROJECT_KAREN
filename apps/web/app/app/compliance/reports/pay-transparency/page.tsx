'use client';
import * as React from 'react';
import { Scale } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro, useSectionLevel } from '@/components/module-page';
import { SourceLink, usePct } from '../../ui';

interface Indicators {
  population: { workers: number; included: number; excludedNoSexRecorded: number; payLevelBasis: string };
  obligation: { reportingRequired: boolean; firstReportBy?: string; frequencyYears?: number };
  genderPayGap: number | null;
  genderPayGapVariable: number | null;
  medianGenderPayGap: number | null;
  medianGenderPayGapVariable: number | null;
  proportionReceivingVariable: { male: number | null; female: number | null };
  quartiles: Array<{ band: string; malePercent: number | null; femalePercent: number | null }>;
  byCategory: Array<{
    category: string;
    workers: number;
    basicPayGap: number | null;
    variablePayGap: number | null;
    totalPayGap: number | null;
    jointPayAssessmentIndicated: boolean;
  }>;
  jointPayAssessment: { thresholdPercent: number; categoriesIndicated: string[] };
}
interface Entity {
  entityId: string;
  entityName: string;
  country: string;
  transposition: {
    status: string;
    law: string | null;
    inForceFrom: string | null;
    source: { url: string; title: string };
    verifiedOn: string;
  };
  directive: { source: { url: string; title: string }; verifiedOn: string };
  indicators: Indicators;
}

export default function PayTransparencyPage() {
  const t = useT();
  const sec = useSectionLevel();
  const locale = useLocale();
  const pct = usePct();
  const [year, setYear] = React.useState(String(new Date().getFullYear() + 1));
  const [query, setQuery] = React.useState(year);
  const r = useApi<Entity[]>(`/v1/compliance/reports/pay-transparency?year=${query}`);
  return (
    <div className="flex flex-col gap-4">
      <PageIntro title={t('compliance.pt.title')} lead={t('compliance.pt.intro')} />
      <form
        className="grid gap-3 md:grid-cols-3 md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(year);
        }}
      >
        <Field id="pt-year" label={t('compliance.pt.year')}>
          {(p) => (
            <Input
              {...p}
              type="number"
              min={2026}
              max={2100}
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit">{t('compliance.showFigures')}</Button>
      </form>
      {r.error ? (
        <EmptyState
          level={sec.level}
          icon={<Scale aria-hidden />}
          title={r.error.status === 403 ? t('compliance.noAccess') : t('compliance.noRule')}
        />
      ) : !r.data ? (
        <Skeleton className="h-64 w-full" />
      ) : r.data.length === 0 ? (
        <EmptyState level={sec.level} icon={<Scale aria-hidden />} title={t('compliance.pt.none')} />
      ) : (
        r.data.map((e) => {
          const i = e.indicators;
          return (
            <Card key={e.entityId} className="flex flex-col gap-3">
              <CardTitle as={sec.heading} className="flex flex-wrap items-center gap-2">
                {e.entityName}
                <Badge>{e.country}</Badge>
                <Badge tone={e.transposition.status === 'transposed' ? 'success' : 'warning'}>
                  {t(`compliance.ptStatus.${e.transposition.status}`)}
                </Badge>
              </CardTitle>
              {e.transposition.law ? <p className="text-callout">{e.transposition.law}</p> : null}
              {e.transposition.inForceFrom ? (
                <p className="text-footnote text-text-secondary">
                  {t('compliance.pt.inForce', { date: formatDate(e.transposition.inForceFrom, locale) })}
                </p>
              ) : null}
              <SourceLink source={e.transposition.source} verifiedOn={e.transposition.verifiedOn} />
              <p className="text-callout">
                {i.obligation.reportingRequired && i.obligation.firstReportBy
                  ? t('compliance.pt.required', {
                      date: formatDate(i.obligation.firstReportBy, locale),
                      years: i.obligation.frequencyYears ?? 1,
                      count: i.obligation.frequencyYears ?? 1,
                    })
                  : t('compliance.pt.notRequired', {
                      workers: i.population.workers,
                      count: i.population.workers,
                    })}
              </p>
              <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
                {(
                  [
                    ['gap', i.genderPayGap],
                    ['medianGap', i.medianGenderPayGap],
                    ['variableGap', i.genderPayGapVariable],
                    ['medianVariableGap', i.medianGenderPayGapVariable],
                    ['variableWomen', i.proportionReceivingVariable.female],
                    ['variableMen', i.proportionReceivingVariable.male],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <dt className="text-footnote text-text-secondary">{t(`compliance.pt.${k}`)}</dt>
                    <dd className="text-title-3 tabular-nums">{pct(v)}</dd>
                  </div>
                ))}
              </dl>
              {i.byCategory.length ? (
                <Table dense>
                  <caption className="px-4 py-3 text-left text-callout font-semibold">
                    {t('compliance.pt.byCategory')}
                  </caption>
                  <THead>
                    <tr>
                      <TH>{t('compliance.pt.category')}</TH>
                      <TH className="text-right">{t('compliance.pt.basic')}</TH>
                      <TH className="text-right">{t('compliance.pt.variable')}</TH>
                      <TH className="text-right">{t('compliance.pt.total')}</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {i.byCategory.map((c) => (
                      <TR key={c.category}>
                        <TD>
                          {c.category}{' '}
                          {c.jointPayAssessmentIndicated ? (
                            <Badge tone="warning">{t('compliance.pt.jpaBadge')}</Badge>
                          ) : null}
                        </TD>
                        <TD className="text-right">{pct(c.basicPayGap)}</TD>
                        <TD className="text-right">{pct(c.variablePayGap)}</TD>
                        <TD className="text-right">{pct(c.totalPayGap)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              ) : null}
              <p className="text-footnote text-text-secondary">
                {i.jointPayAssessment.categoriesIndicated.length
                  ? t('compliance.pt.jpa', {
                      threshold: i.jointPayAssessment.thresholdPercent,
                      categories: i.jointPayAssessment.categoriesIndicated.join(', '),
                    })
                  : t('compliance.pt.noJpa', { threshold: i.jointPayAssessment.thresholdPercent })}
              </p>
              <SourceLink source={e.directive.source} verifiedOn={e.directive.verifiedOn} />
            </Card>
          );
        })
      )}
    </div>
  );
}
