'use client';
import * as React from 'react';
import { BadgeCheck } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { targetHref } from '@thapsus/core/links';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';
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
        // grouped rows (ADR-0180): each check opens its own page
        <ListSection
          title={t('compliance.rtw.title')}
          headingLevel={3}
          action={
            data.rightToWork.status === 'not_due' ? (
              <Badge>{t('actionable.person.rtwNotDue')}</Badge>
            ) : (
              <StatusBadge status={data.rightToWork.status} />
            )
          }
          footer={
            <EntityLink href="/app/compliance/right-to-work">{t('actionable.person.rtwList')}</EntityLink>
          }
        >
          {data.rightToWork.checks.length ? (
            data.rightToWork.checks.map((c) => (
              <ListItem
                key={c.id}
                href={targetHref({ type: 'rtw_check', id: c.id })!}
                linkAs={IntentLink}
                title={formatDate(c.checkedOn, locale)}
                subtitle={
                  <>
                    <span className="block">{t(`compliance.rtw.list.${c.listType}`)}</span>
                    {c.followUpDueOn ? (
                      <span className="block">
                        {t('actionable.person.followUpOn', { date: d(c.followUpDueOn) })}
                      </span>
                    ) : null}
                  </>
                }
                accessory={
                  <Badge tone={c.current ? 'success' : 'neutral'}>
                    {t(c.current ? 'actionable.common.current' : 'actionable.common.superseded')}
                  </Badge>
                }
              />
            ))
          ) : (
            <ListItem
              title={<span className="text-text-secondary">{t('actionable.person.noChecks')}</span>}
            />
          )}
        </ListSection>
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
        <ListSection
          title={t('actionable.person.requirements')}
          headingLevel={3}
          footer={<EntityLink href="/app/compliance/matrix">{t('actionable.person.matrix')}</EntityLink>}
        >
          {data.requirements.map((r) => (
            <ListItem
              key={r.requirementId}
              title={r.name}
              subtitle={r.expiresOn ? t('actionable.person.expiresOn', { date: d(r.expiresOn) }) : undefined}
              accessory={<StatusBadge status={r.status} />}
            />
          ))}
        </ListSection>
      ) : null}
    </div>
  );
}
