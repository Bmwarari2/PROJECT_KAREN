'use client';
import * as React from 'react';
import { KeyRound, LogIn, ShieldAlert, UserCog } from 'lucide-react';
import { Badge, Button, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSectionLevel } from '@/components/module-page';
import {
  Checkbox,
  FormError,
  PageHeader,
  ReadOnlyNote,
  SettingsCard,
  useAction,
  useFormat,
  usePermission,
} from '../kit';

interface Person {
  userId: string;
  displayName: string;
}
interface Centre {
  alerts: Array<{
    id: string;
    ruleId: string;
    severity: string;
    firstSeenAt: string;
    lastSeenAt: string;
    eventCount: number;
    subject: Person | null;
    acknowledgedAt: string | null;
  }>;
  signIns: { succeeded7d: number; failed7d: number; lockedNow: number };
  recentFailures: Array<{ at: string; person: Person | null; network: string | null }>;
  adminChanges: Array<{
    at: string;
    action: string;
    actor: Person | null;
    targetType: string | null;
    target: Person | null;
  }>;
  mfa: { users: number; withMfa: number; admins: number; adminsWithoutMfa: number };
  recipients: Array<{ userId: string; displayName: string; email: string }>;
  recipientsAreDefault: boolean;
  candidates: Array<{ userId: string; displayName: string; email: string }>;
}
const TONE = { low: 'neutral', medium: 'warning', high: 'danger', critical: 'danger' } as const;

/**
 * The workspace's Security centre (ADR-0178): security alerts Thapsus-HR's monitoring raised about this
 * workspace, recent failed sign-ins, admin changes from the audit log, two-step verification adoption, and
 * which admins receive security alert emails.
 */
export default function SecurityCentrePage() {
  const t = useT();
  const fmt = useFormat();
  const sec = useSectionLevel();
  const has = usePermission();
  const canManage = has('settings.manage');
  const c = useApi<Centre>('/v1/settings/security-centre');
  const action = useAction();
  const [chosen, setChosen] = React.useState<Set<string> | null>(null);

  if (!c.data) return <Skeleton className="h-64 w-full" />;
  const d = c.data;
  const picked = chosen ?? new Set(d.recipientsAreDefault ? [] : d.recipients.map((r) => r.userId));
  const actionLabel = (a: string) => {
    const k = `admin.securityCentre.action.${a}`;
    const v = t(k);
    return v === k ? a : v;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.securityCentre.title')} lead={t('admin.securityCentre.lead')} />

      <ListSection
        id="sc-alerts"
        headingLevel={sec.level}
        title={t('admin.securityCentre.alerts')}
        description={t('admin.securityCentre.alertsHint')}
      >
        {d.alerts.length ? (
          d.alerts.map((a) => (
            <ListItem
              key={a.id}
              leading={<ShieldAlert aria-hidden />}
              title={t(`backoffice.security.rules.${a.ruleId}.name`)}
              subtitle={
                <>
                  <span className="block">{t(`backoffice.security.rules.${a.ruleId}.summary`)}</span>
                  <span className="block">
                    {[
                      t('admin.securityCentre.events', { count: a.eventCount }),
                      a.subject ? t('admin.securityCentre.about', { name: a.subject.displayName }) : null,
                      t('admin.securityCentre.seen', {
                        first: fmt.dateTime(a.firstSeenAt),
                        last: fmt.dateTime(a.lastSeenAt),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </>
              }
              meta={
                a.acknowledgedAt
                  ? t('admin.securityCentre.acknowledged', { at: fmt.dateTime(a.acknowledgedAt) })
                  : undefined
              }
              actions={
                canManage && !a.acknowledgedAt ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      if (
                        await action.run(
                          () =>
                            api(`/v1/settings/security-centre/alerts/${a.id}/acknowledge`, {
                              method: 'POST',
                            }),
                          t('admin.securityCentre.acknowledgedToast'),
                        )
                      )
                        c.reload();
                    }}
                  >
                    {t('admin.securityCentre.acknowledge')}
                  </Button>
                ) : undefined
              }
              accessory={
                <Badge tone={TONE[a.severity as keyof typeof TONE] ?? 'neutral'}>
                  {t(`backoffice.security.severity.${a.severity}`)}
                </Badge>
              }
            />
          ))
        ) : (
          <ListItem title={t('admin.securityCentre.noAlerts')} />
        )}
      </ListSection>

      <ListSection id="sc-signins" headingLevel={sec.level} title={t('admin.securityCentre.signIns')}>
        <ListItem
          leading={<LogIn aria-hidden />}
          title={t('admin.securityCentre.succeeded')}
          accessory={<span className="tabular-nums">{d.signIns.succeeded7d}</span>}
        />
        <ListItem
          leading={<LogIn aria-hidden />}
          title={t('admin.securityCentre.failed')}
          accessory={<span className="tabular-nums">{d.signIns.failed7d}</span>}
        />
        <ListItem
          leading={<KeyRound aria-hidden />}
          title={t('admin.securityCentre.locked')}
          accessory={<span className="tabular-nums">{d.signIns.lockedNow}</span>}
        />
      </ListSection>

      <ListSection id="sc-failures" headingLevel={sec.level} title={t('admin.securityCentre.recentFailures')}>
        {d.recentFailures.length ? (
          d.recentFailures.map((f, i) => (
            <ListItem
              key={`${f.at}-${i}`}
              leading={<LogIn aria-hidden />}
              title={f.person?.displayName ?? t('admin.securityCentre.unknownPerson')}
              subtitle={
                f.network
                  ? t('admin.securityCentre.failureLine', { network: f.network })
                  : t('admin.securityCentre.networkUnknown')
              }
              meta={fmt.dateTime(f.at)}
            />
          ))
        ) : (
          <ListItem title={t('admin.securityCentre.noFailures')} />
        )}
      </ListSection>

      <ListSection id="sc-changes" headingLevel={sec.level} title={t('admin.securityCentre.adminChanges')}>
        {d.adminChanges.length ? (
          d.adminChanges.map((ch, i) => (
            <ListItem
              key={`${ch.at}-${i}`}
              leading={<UserCog aria-hidden />}
              title={actionLabel(ch.action)}
              subtitle={[
                ch.actor
                  ? t('admin.securityCentre.changeBy', { name: ch.actor.displayName })
                  : t('admin.securityCentre.changeBySystem'),
                ch.target ? t('admin.securityCentre.changeTarget', { name: ch.target.displayName }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              meta={fmt.dateTime(ch.at)}
            />
          ))
        ) : (
          <ListItem title={t('admin.securityCentre.noChanges')} />
        )}
      </ListSection>

      <SettingsCard id="sc-mfa" title={t('admin.securityCentre.mfa')}>
        <p className="text-callout">
          {t('admin.securityCentre.mfaUsers', { withMfa: d.mfa.withMfa, users: d.mfa.users })}
        </p>
        <p className="text-callout">
          {t('admin.securityCentre.mfaAdmins', { count: d.mfa.adminsWithoutMfa })}
        </p>
      </SettingsCard>

      <SettingsCard
        id="sc-recipients"
        title={t('admin.securityCentre.recipients')}
        description={t('admin.securityCentre.recipientsHint')}
      >
        {d.recipientsAreDefault ? (
          <p className="text-callout text-text-secondary">{t('admin.securityCentre.recipientsDefault')}</p>
        ) : null}
        {canManage ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await action.run(
                  () =>
                    api('/v1/settings/security-centre/recipients', {
                      method: 'PUT',
                      json: { userIds: [...picked] },
                    }),
                  t('admin.securityCentre.recipientsSaved'),
                )
              ) {
                setChosen(null);
                c.reload();
              }
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-callout font-semibold">
                {t('admin.securityCentre.chooseRecipients')}
              </legend>
              {d.candidates.map((p) => (
                <Checkbox
                  key={p.userId}
                  id={`sc-r-${p.userId}`}
                  label={`${p.displayName} (${p.email})`}
                  checked={picked.has(p.userId)}
                  onChange={(on) => {
                    const next = new Set(picked);
                    if (on) next.add(p.userId);
                    else next.delete(p.userId);
                    setChosen(next);
                  }}
                />
              ))}
            </fieldset>
            <FormError message={action.error} />
            <Button type="submit" className="self-start" loading={action.busy}>
              {t('admin.securityCentre.saveRecipients')}
            </Button>
          </form>
        ) : (
          <>
            <ul className="flex flex-col gap-1 text-callout">
              {d.recipients.map((r) => (
                <li key={r.userId}>{r.displayName}</li>
              ))}
            </ul>
            <ReadOnlyNote />
          </>
        )}
      </SettingsCard>
    </div>
  );
}
