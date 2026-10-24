'use client';
import { BookCheck } from 'lucide-react';
import { Button, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDate, formatDateTime, type Locale } from '@thapsus/core/i18n';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle } from '../../ui';
import { SecurityNav, SeverityBadge, securityCall, useRun } from '../nav';

interface Rule {
  id: string;
  version: number;
  effectiveFrom: string;
  status: 'active' | 'planned';
  area: string;
  severity: string;
  mitre: { id: string; name: string };
  windowMinutes: number | null;
  threshold: number | null;
  dedupeMinutes: number;
  containment: string[];
  customerVisible: boolean;
  needs: string | null;
  tuning: Array<{ on: string; note: string }>;
  enabled: boolean;
  lastTest: { passed: boolean; ranAt: string } | null;
  detections30d: number;
}
const AREAS = [
  'credential',
  'takeover',
  'privilege',
  'exfiltration',
  'probing',
  'staff',
  'deception',
  'ai',
  'cloud',
];

/**
 * The detection rule catalogue (ADR-0177): each rule with its severity, MITRE ATT&CK technique, logic,
 * containment, fixture test result and tuning notes, grouped by area. A rule can be turned off in this
 * region; its logic changes only with a new version in the repository.
 */
export default function RulesPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const cat = useApi<{ catalogueVersion: number; rules: Rule[] }>('/v1/backoffice/security/rules');
  const { busy, run } = useRun();
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');

  const testAll = () =>
    run(
      'test',
      () =>
        securityCall<Array<{ passed: boolean }>>('/v1/backoffice/security/rules/test', { method: 'POST' }),
      (r) =>
        t('backoffice.security.rules.tested', {
          passed: r.filter((x) => x.passed).length,
          total: r.length,
        }),
    ).then(() => cat.reload());
  const toggle = (r: Rule) =>
    run(
      r.id,
      () =>
        securityCall(`/v1/backoffice/security/rules/${r.id}`, {
          method: 'PATCH',
          json: { enabled: !r.enabled },
        }),
      t('backoffice.security.rules.toggled'),
    ).then(() => cat.reload());

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageTitle
          title={t('backoffice.security.rules.title')}
          lead={
            cat.data ? t('backoffice.security.rules.lead', { version: cat.data.catalogueVersion }) : undefined
          }
        >
          <Button variant="secondary" loading={busy === 'test'} onClick={testAll}>
            {t('backoffice.security.rules.test')}
          </Button>
        </PageTitle>
        <SecurityNav />
      </div>
      {!cat.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        AREAS.filter((a) => cat.data!.rules.some((r) => r.area === a)).map((area) => (
          <ListSection key={area} id={`area-${area}`} title={t(`backoffice.security.area.${area}`)}>
            {cat
              .data!.rules.filter((r) => r.area === area)
              .map((r) => (
                <ListItem
                  key={r.id}
                  leading={<BookCheck aria-hidden />}
                  title={`${t(`backoffice.security.rules.${r.id}.name`)} (${r.id})`}
                  subtitle={
                    <>
                      <span className="block">{t(`backoffice.security.rules.${r.id}.summary`)}</span>
                      <span className="block">
                        {t('backoffice.security.rules.line', {
                          severity: t(`backoffice.security.severity.${r.severity}`),
                          mitre: `${r.mitre.id} ${r.mitre.name}`,
                        })}
                      </span>
                      {r.status === 'planned' ? (
                        <span className="block">
                          {t('backoffice.security.rules.needs', { needs: r.needs ?? '' })}
                        </span>
                      ) : (
                        <>
                          <span className="block">
                            {t('backoffice.security.rules.logic', {
                              window: r.windowMinutes ?? 0,
                              threshold: r.threshold ?? 0,
                              dedupe: r.dedupeMinutes,
                            })}
                          </span>
                          <span className="block">
                            {[
                              r.containment.length
                                ? t('backoffice.security.rules.containment', {
                                    kinds: r.containment
                                      .map((k) => t(`backoffice.security.containment.${k}`))
                                      .join(', '),
                                  })
                                : null,
                              r.customerVisible ? t('backoffice.security.rules.customer') : null,
                              r.lastTest
                                ? t('backoffice.security.rules.lastTest', {
                                    result: r.lastTest.passed
                                      ? t('backoffice.security.rules.passed')
                                      : t('backoffice.security.rules.failed'),
                                    at: when(r.lastTest.ranAt),
                                  })
                                : t('backoffice.security.rules.notTested'),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </>
                      )}
                      <details className="mt-1">
                        <summary className="cursor-pointer text-footnote font-semibold text-accent">
                          {t('backoffice.security.rules.tuning')}
                        </summary>
                        <ul className="mt-1 flex flex-col gap-1 text-footnote">
                          {r.tuning.map((n) => (
                            <li key={n.on + n.note}>
                              <span className="font-semibold">{formatDate(n.on, locale)}</span> {n.note}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </>
                  }
                  meta={
                    <>
                      <span className="block">
                        {r.status === 'planned'
                          ? t('backoffice.security.rules.planned')
                          : r.enabled
                            ? t('backoffice.security.rules.on')
                            : t('backoffice.security.rules.off')}
                      </span>
                      {r.status === 'active' ? (
                        <span className="block">
                          {t('backoffice.security.rules.detections30d', { count: r.detections30d })}
                        </span>
                      ) : null}
                    </>
                  }
                  actions={
                    r.status === 'active' ? (
                      <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => toggle(r)}>
                        {r.enabled
                          ? t('backoffice.security.rules.turnOff')
                          : t('backoffice.security.rules.turnOn')}
                      </Button>
                    ) : undefined
                  }
                  accessory={<SeverityBadge severity={r.severity} />}
                />
              ))}
          </ListSection>
        ))
      )}
    </div>
  );
}
