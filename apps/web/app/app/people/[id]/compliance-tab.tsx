'use client';
import * as React from 'react';
import { BadgeCheck } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { targetHref } from '@thapsus/core/links';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { EntityLink } from '@/components/person-link';
import { StatusBadge } from '../../compliance/ui';

interface PersonCompliance {
  employeeId: string;
  employeeName: string;
  jurisdiction: string | null;
  rightToWork: {
    status: string;
    retainUntil: string | null;
    checks: Array<{
      id: string;
      checkMethod: string;
      listType: string;
      checkedOn: string;
      followUpDueOn: string | null;
      excuseEndsOn: string | null;
      current: boolean;
      hasEvidence: boolean;
    }>;
  } | null;
  i9: {
    status: string;
    recordId: string | null;
    section1CompletedOn: string | null;
    section2DueOn: string | null;
    section2CompletedOn: string | null;
    reverificationDueOn: string | null;
  } | null;
  requirements: Array<{
    requirementId: string;
    name: string;
    kind: string;
    status: string;
    issuedOn: string | null;
    expiresOn: string | null;
  }>;
}

/**
 * A person's compliance on their profile (ADR-0161): right to work with every check (each opens its
 * own page), the Form I-9 and the requirements that apply to them. Loaded only when the tab opens: the
 * API audits the view as sensitive.
 */
export function ComplianceTab({ employeeId }: { employeeId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error } = useApi<PersonCompliance>(`/v1/compliance/people/${employeeId}`);
  const d = (v: string | null) => (v ? formatDate(v, locale) : '—');
  if (error) return <EmptyState level={3} title={t('compliance.noAccess')} />;
  if (!data) return <Skeleton className="h-48 w-full" />;
  const nothing = !data.rightToWork && !data.i9 && !data.requirements.length;
  if (nothing)
    return (
      <EmptyState level={3} icon={<BadgeCheck aria-hidden />} title={t('actionable.person.noCompliance')} />
    );
  return (
    <div className="flex flex-col gap-4" data-testid="profile-compliance">
      {data.rightToWork ? (
        <Card className="flex flex-col gap-3 p-0">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-5">
            <CardTitle as="h3" className="mr-auto">
              {t('compliance.rtw.title')}
            </CardTitle>
            {data.rightToWork.status === 'not_due' ? (
              <Badge>{t('actionable.person.rtwNotDue')}</Badge>
            ) : (
              <StatusBadge status={data.rightToWork.status} />
            )}
          </div>
          {data.rightToWork.checks.length ? (
            <div className="[&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
              <Table dense scrollLabel={t('compliance.rtw.title')}>
                <THead>
                  <tr>
                    <TH>{t('compliance.rtw.checkedOn')}</TH>
                    <TH>{t('compliance.rtw.listType')}</TH>
                    <TH>{t('compliance.rtw.followUp')}</TH>
                    <TH>{t('common.status')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {data.rightToWork.checks.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <EntityLink href={targetHref({ type: 'rtw_check', id: c.id })!}>
                          {formatDate(c.checkedOn, locale)}
                        </EntityLink>
                      </TD>
                      <TD>{t(`compliance.rtw.list.${c.listType}`)}</TD>
                      <TD>{d(c.followUpDueOn)}</TD>
                      <TD>
                        <Badge tone={c.current ? 'success' : 'neutral'}>
                          {t(c.current ? 'actionable.common.current' : 'actionable.common.superseded')}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="px-5 pb-5 text-callout text-text-secondary">{t('actionable.person.noChecks')}</p>
          )}
          <p className="px-5 pb-5 text-callout">
            <EntityLink href="/app/compliance/right-to-work">{t('actionable.person.rtwList')}</EntityLink>
          </p>
        </Card>
      ) : null}
      {data.i9 ? (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle as="h3" className="mr-auto">
              {t('actionable.person.i9')}
            </CardTitle>
            <StatusBadge status={data.i9.status} />
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-callout sm:grid-cols-2">
            <div>
              <dt className="text-footnote text-text-secondary">{t('actionable.person.section1')}</dt>
              <dd>{d(data.i9.section1CompletedOn)}</dd>
            </div>
            <div>
              <dt className="text-footnote text-text-secondary">{t('actionable.person.section2')}</dt>
              <dd>
                {data.i9.section2CompletedOn
                  ? d(data.i9.section2CompletedOn)
                  : t('actionable.person.dueBy', { date: d(data.i9.section2DueOn) })}
              </dd>
            </div>
            {data.i9.reverificationDueOn ? (
              <div>
                <dt className="text-footnote text-text-secondary">{t('actionable.person.reverification')}</dt>
                <dd>{d(data.i9.reverificationDueOn)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-callout">
            <EntityLink href="/app/compliance/i9">{t('actionable.person.i9List')}</EntityLink>
          </p>
        </Card>
      ) : null}
      {data.requirements.length ? (
        <Card className="flex flex-col gap-3 p-0">
          <div className="px-5 pt-5">
            <CardTitle as="h3">{t('actionable.person.requirements')}</CardTitle>
          </div>
          <div className="[&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
            <Table dense scrollLabel={t('actionable.person.requirements')}>
              <THead>
                <tr>
                  <TH>{t('actionable.person.requirement')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>{t('actionable.person.expires')}</TH>
                </tr>
              </THead>
              <tbody>
                {data.requirements.map((r) => (
                  <TR key={r.requirementId}>
                    <TD>{r.name}</TD>
                    <TD>
                      <StatusBadge status={r.status} />
                    </TD>
                    <TD>{d(r.expiresOn)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="px-5 pb-5 text-callout">
            <EntityLink href="/app/compliance/matrix">{t('actionable.person.matrix')}</EntityLink>
          </p>
        </Card>
      ) : null}
    </div>
  );
}
