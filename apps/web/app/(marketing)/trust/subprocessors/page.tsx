import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Section, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { HOME_REGIONS, isHomeRegion, type HomeRegion } from '@thapsus/core';
import { formatDate } from '@thapsus/core/i18n';
import { LEGAL, TRUST } from '@thapsus/core/trust';
import { serverContext } from '@/lib/server';

export async function generateMetadata() {
  const { t } = await serverContext();
  return { title: t('trust.sub.meta.title'), description: t('trust.sub.meta.description') };
}

/** Known column and section names from docs/SUBPROCESSORS.md, translated; the rows are the published legal list. */
const COLUMN_KEYS: Record<string, string> = {
  'Sub-processor': 'subprocessor',
  Purpose: 'purpose',
  'UK tenants': 'location',
  'EU tenants': 'location',
  'US tenants': 'location',
  'Personal data': 'personalData',
  Location: 'location',
  Integration: 'integration',
  'Data sent': 'dataSent',
};
const REGION_COLUMN: Record<HomeRegion, string> = { uk: 'UK tenants', eu: 'EU tenants', us: 'US tenants' };
const SECTION_KEYS: Record<string, string> = {
  'Core infrastructure (all customers)': 'core',
  'Billing (company-level data only)': 'billing',
  'Optional features (only when the customer turns them on)': 'optional',
  'Customer-directed integrations': 'integrations',
};

export default async function SubprocessorsPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { t, locale } = await serverContext();
  const q = await searchParams;
  const region: HomeRegion = isHomeRegion(q.region) ? q.region : 'uk';
  const otherRegions = HOME_REGIONS.filter((r) => r !== region).map((r) => REGION_COLUMN[r]);
  const col = (c: string) => (COLUMN_KEYS[c] ? t(`trust.sub.col.${COLUMN_KEYS[c]}`) : c);
  const changes = TRUST.subprocessors.changes.filter((c) => c.regions.includes(region));
  return (
    <>
      <Section tone="bg" className="pt-12 md:pt-16" labelledBy="sub-title">
        <Link href="/trust" className="inline-flex items-center gap-1 text-callout">
          <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('trust.sub.back')}
        </Link>
        <h1 id="sub-title" className="mt-4 text-title-1">
          {t('trust.sub.title')}
        </h1>
        <p className="mt-4 max-w-[var(--prose-width)] text-body text-text-secondary">
          {t('trust.sub.lead', { days: LEGAL.subprocessorNoticeDays, count: LEGAL.subprocessorNoticeDays })}
        </p>
        <nav aria-label={t('trust.sub.regionLabel')} className="mt-6 flex flex-wrap gap-2">
          {HOME_REGIONS.map((r) => (
            <Link
              key={r}
              href={`/trust/subprocessors?region=${r}`}
              aria-current={r === region ? 'page' : undefined}
              className={`rounded-pill border px-4 py-2 text-callout font-semibold no-underline ${r === region ? 'border-accent bg-accent text-on-accent' : 'border-border text-text hover:border-accent'}`}
            >
              {t(`regions.${r}`)}
            </Link>
          ))}
        </nav>
      </Section>
      <Section tone="surface" labelledBy="sub-list-title">
        <h2 id="sub-list-title" className="sr-only">
          {t('trust.sub.listTitle', { region: t(`regions.${region}`) })}
        </h2>
        <div className="grid gap-10">
          {TRUST.subprocessors.sections.map((s) => {
            const keep = s.columns.map((c, i) => ({ c, i })).filter(({ c }) => !otherRegions.includes(c));
            const sectionId = `sub-${SECTION_KEYS[s.title] ?? s.title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
            const title = SECTION_KEYS[s.title] ? t(`trust.sub.section.${SECTION_KEYS[s.title]}`) : s.title;
            return (
              <section key={s.title} aria-labelledby={sectionId} className="min-w-0">
                <h3 id={sectionId} className="text-title-3">
                  {title}
                </h3>
                <div className="mt-3">
                  <Table dense scrollLabel={t('admin.tableScroll', { name: title })}>
                    <THead>
                      <tr>
                        {keep.map(({ c }) => (
                          <TH key={c} scope="col">
                            {col(c)}
                          </TH>
                        ))}
                      </tr>
                    </THead>
                    <tbody>
                      {s.rows.map((row) => (
                        <TR key={row[0]}>
                          {keep.map(({ c, i }, k) => (
                            <TD key={c} className="align-top" label={k > 0 ? col(c) : undefined}>
                              {row[i]}
                            </TD>
                          ))}
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </section>
            );
          })}
          <section aria-labelledby="sub-changes" className="min-w-0">
            <h3 id="sub-changes" className="text-title-3">
              {t('trust.sub.changes')}
            </h3>
            <div className="mt-3 rounded-lg bg-surface-raised">
              <Table dense scrollLabel={t('admin.tableScroll', { name: t('trust.sub.changes') })}>
                <THead>
                  <tr>
                    <TH scope="col">{t('trust.sub.announced')}</TH>
                    <TH scope="col">{t('trust.sub.effective')}</TH>
                    <TH scope="col">{t('trust.sub.change')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {changes.map((c) => (
                    <TR key={c.id}>
                      <TD className="tabular-nums">{formatDate(c.announced, locale)}</TD>
                      <TD className="tabular-nums" label={t('trust.sub.effective')}>
                        {formatDate(c.effectiveFrom, locale)}
                      </TD>
                      <TD label={t('trust.sub.change')}>{c.change}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
            <p className="mt-3 text-footnote text-text-secondary">{t('trust.sub.subscribe')}</p>
          </section>
        </div>
      </Section>
    </>
  );
}
