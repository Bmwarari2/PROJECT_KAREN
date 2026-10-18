'use client';
import * as React from 'react';
import { Scale } from 'lucide-react';
import { Button, Card, CardTitle, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { selectClass, SourceLink, usePct } from '../../ui';

interface Gpg {
  snapshotDate: string;
  deadline: string;
  employeeThreshold: number;
  headcount: number;
  required: boolean;
  dataSource: string;
  population: { excludedNoSexRecorded: number; male: number; female: number };
  figures: { meanHourlyPayGap: number | null; medianHourlyPayGap: number | null; meanBonusGap: number | null; medianBonusGap: number | null; bonusProportions: { male: number | null; female: number | null }; quartiles: Array<{ band: string; total: number; malePercent: number | null; femalePercent: number | null }> };
  source: { url: string; title: string };
  verifiedOn: string;
}

export default function GenderPayGapPage() {
  const t = useT();
  const locale = useLocale();
  const pct = usePct();
  const [form, setForm] = React.useState({ year: String(new Date().getFullYear()), sector: 'privateAndVoluntary' });
  const [query, setQuery] = React.useState(() => new URLSearchParams(form).toString());
  const r = useApi<Gpg>(`/v1/compliance/reports/gender-pay-gap?${query}`);
  const fig = (label: string, v: number | null) => (
    <div className="flex flex-col gap-1">
      <dt className="text-footnote text-text-secondary">{label}</dt>
      <dd className="text-title-2 tabular-nums">{pct(v)}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-2">{t('compliance.gpg.title')}</h1>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('compliance.gpg.intro')}</p>
      <form
        className="grid gap-3 md:grid-cols-3 md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(new URLSearchParams(form).toString());
        }}
      >
        <Field id="gpg-year" label={t('compliance.gpg.year')}>{(p) => <Input {...p} type="number" min={2017} max={2100} inputMode="numeric" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />}</Field>
        <Field id="gpg-sector" label={t('compliance.gpg.sector')}>
          {(p) => (
            <select {...p} className={selectClass} value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
              <option value="privateAndVoluntary">{t('compliance.gpg.sectorName.privateAndVoluntary')}</option>
              <option value="publicAuthority">{t('compliance.gpg.sectorName.publicAuthority')}</option>
            </select>
          )}
        </Field>
        <Button type="submit">{t('compliance.showFigures')}</Button>
      </form>
      {r.error ? (
        <EmptyState icon={<Scale aria-hidden />} title={r.error.status === 403 ? t('compliance.noAccess') : t('compliance.noRule')} />
      ) : !r.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Card>
            <CardTitle>{t('compliance.gpg.snapshot', { date: formatDate(r.data.snapshotDate, locale), deadline: formatDate(r.data.deadline, locale) })}</CardTitle>
            <p className="mt-2 text-callout">{r.data.required ? t('compliance.gpg.required', { count: r.data.headcount, threshold: r.data.employeeThreshold }) : t('compliance.gpg.notRequired', { count: r.data.headcount, threshold: r.data.employeeThreshold })}</p>
            <p className="text-footnote text-text-secondary">{t(`compliance.gpg.dataSource.${r.data.dataSource}`)}</p>
            {r.data.population.excludedNoSexRecorded ? <p className="text-footnote text-text-secondary">{t('compliance.gpg.excluded', { count: r.data.population.excludedNoSexRecorded })}</p> : null}
            <SourceLink source={r.data.source} verifiedOn={r.data.verifiedOn} />
          </Card>
          <Card>
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
              {fig(t('compliance.gpg.meanHourly'), r.data.figures.meanHourlyPayGap)}
              {fig(t('compliance.gpg.medianHourly'), r.data.figures.medianHourlyPayGap)}
              {fig(t('compliance.gpg.meanBonus'), r.data.figures.meanBonusGap)}
              {fig(t('compliance.gpg.medianBonus'), r.data.figures.medianBonusGap)}
              {fig(t('compliance.gpg.bonusMen'), r.data.figures.bonusProportions.male)}
              {fig(t('compliance.gpg.bonusWomen'), r.data.figures.bonusProportions.female)}
            </dl>
          </Card>
          <Card className="p-0">
            <Table dense>
              <caption className="px-4 py-3 text-left text-callout font-semibold">{t('compliance.gpg.quartiles')}</caption>
              <THead>
                <tr>
                  <TH>{t('compliance.gpg.band')}</TH>
                  <TH className="text-right">{t('compliance.gpg.men')}</TH>
                  <TH className="text-right">{t('compliance.gpg.women')}</TH>
                </tr>
              </THead>
              <tbody>
                {r.data.figures.quartiles.map((q) => (
                  <TR key={q.band}>
                    <TD>{t(`compliance.band.${q.band}`)}</TD>
                    <TD className="text-right">{pct(q.malePercent)}</TD>
                    <TD className="text-right">{pct(q.femalePercent)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
