'use client';
import * as React from 'react';
import { Scale } from 'lucide-react';
import {
  Button,
  Card,
  CardTitle,
  PageSection,
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
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro, useSectionLevel } from '@/components/module-page';
import { SourceLink } from '../../ui';

interface Eeo1 {
  year: number;
  snapshotDate: string;
  window: { from: string; to: string };
  required: boolean;
  threshold: number;
  totalEmployees: number;
  notReported: number;
  unmappedJobs: number;
  suppressionThreshold: number | null;
  table: Array<{
    jobCategory: string;
    total: number | null;
    cells: Array<{ raceEthnicity: string; sex: string; count: number | null; suppressed: boolean }>;
  }>;
  source: { url: string; title: string };
  verifiedOn: string;
}

export default function Eeo1Page() {
  const t = useT();
  const sec = useSectionLevel();
  const locale = useLocale();
  const [year, setYear] = React.useState(String(new Date().getFullYear()));
  const [query, setQuery] = React.useState(year);
  const r = useApi<Eeo1>(`/v1/compliance/reports/eeo-1?year=${query}`);
  const races =
    r.data?.table[0]?.cells
      .filter((c) => c.sex === r.data!.table[0]!.cells[0]!.sex)
      .map((c) => c.raceEthnicity) ?? [];
  const sexes = [...new Set(r.data?.table[0]?.cells.map((c) => c.sex) ?? [])];
  const cell = (c: { count: number | null; suppressed: boolean } | undefined) =>
    c?.suppressed
      ? t('compliance.eeo1.suppressed', { k: r.data?.suppressionThreshold ?? 0 })
      : formatNumber(c?.count ?? 0, locale);
  return (
    <div className="flex flex-col gap-4">
      <PageIntro title={t('compliance.eeo1.title')} lead={t('compliance.eeo1.intro')} />
      <form
        className="grid gap-3 md:grid-cols-3 md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(year);
        }}
      >
        <Field id="eeo-year" label={t('compliance.eeo1.year')}>
          {(p) => (
            <Input
              {...p}
              type="number"
              min={2020}
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
      ) : (
        <>
          <Card>
            <CardTitle as={sec.heading}>
              {t('compliance.eeo1.window', {
                from: formatDate(r.data.window.from, locale),
                to: formatDate(r.data.window.to, locale),
                date: formatDate(r.data.snapshotDate, locale),
              })}
            </CardTitle>
            <p className="mt-2 text-callout">
              {r.data.required
                ? t('compliance.eeo1.required', { count: r.data.totalEmployees, threshold: r.data.threshold })
                : t('compliance.eeo1.notRequired', {
                    count: r.data.totalEmployees,
                    threshold: r.data.threshold,
                  })}
            </p>
            {r.data.notReported ? (
              <p className="text-footnote text-text-secondary">
                {t('compliance.eeo1.notReported', { count: r.data.notReported })}
              </p>
            ) : null}
            {r.data.unmappedJobs ? (
              <p className="text-footnote text-text-secondary">
                {t('compliance.eeo1.unmapped', { count: r.data.unmappedJobs })}
              </p>
            ) : null}
            <p className="text-footnote text-text-secondary">{t('compliance.eeo1.privacy')}</p>
            <SourceLink source={r.data.source} verifiedOn={r.data.verifiedOn} />
          </Card>
          <PageSection headingLevel={sec.level} title={t('compliance.eeo1.tableCaption')}>
            <Table dense scrollLabel={t('compliance.eeo1.tableCaption')} stack={false}>
              <caption className="sr-only">{t('compliance.eeo1.tableCaption')}</caption>
              <THead>
                <tr>
                  <TH>{t('compliance.eeo1.jobCategory')}</TH>
                  {races.flatMap((race) =>
                    sexes.map((sex) => (
                      <TH key={`${race}:${sex}`} className="text-right">
                        {t(`compliance.race.${race}`)} · {t(`compliance.sex.${sex}`)}
                      </TH>
                    )),
                  )}
                  <TH className="text-right">{t('compliance.eeo1.total')}</TH>
                </tr>
              </THead>
              <tbody>
                {r.data.table.map((row) => (
                  <TR key={row.jobCategory}>
                    <TD className="font-semibold">{t(`compliance.job.${row.jobCategory}`)}</TD>
                    {races.flatMap((race) =>
                      sexes.map((sex) => (
                        <TD key={`${race}:${sex}`} className="text-right">
                          {cell(row.cells.find((c) => c.raceEthnicity === race && c.sex === sex))}
                        </TD>
                      )),
                    )}
                    <TD className="text-right">
                      {row.total === null
                        ? t('compliance.eeo1.suppressed', { k: r.data!.suppressionThreshold ?? 0 })
                        : formatNumber(row.total, locale)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </PageSection>
        </>
      )}
    </div>
  );
}
