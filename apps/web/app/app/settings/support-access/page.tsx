'use client';
import * as React from 'react';
import { LifeBuoy } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  ConfirmAction,
  FormError,
  PageHeader,
  RadioGroup,
  ReadOnlyNote,
  selectClass,
  SettingsCard,
  useAction,
  useFormat,
  usePermission,
} from '../kit';
import { useSectionLevel } from '@/components/module-page';

interface Grant {
  id: string;
  staffId: string;
  accessLevel: 'read' | 'read_write';
  reason: string;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Durations offered (the API allows 1 to 720 hours). */
const DURATIONS = [1, 4, 8, 24, 72, 168, 720];
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function statusOf(g: Grant, now: number): 'revoked' | 'expired' | 'active' {
  if (g.revokedAt) return 'revoked';
  return new Date(g.expiresAt).getTime() <= now ? 'expired' : 'active';
}

/** Time-limited access for Thapsus support, granted and revoked by the customer. */
export default function SupportAccessPage() {
  const t = useT();
  const sec = useSectionLevel();
  const locale = useLocale();
  const fmt = useFormat();
  const has = usePermission();
  const canManage = has('settings.manage');
  const grants = useApi<Grant[]>('/v1/settings/support-grants');
  const [v, setV] = React.useState({
    staffId: '',
    accessLevel: 'read' as Grant['accessLevel'],
    hours: '24',
    reason: '',
  });
  const grant = useAction();
  const now = Date.now();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await grant.run(
      () =>
        api('/v1/settings/support-grants', {
          method: 'POST',
          json: {
            staffId: v.staffId.trim().toLowerCase(),
            accessLevel: v.accessLevel,
            hours: Number(v.hours),
            reason: v.reason.trim(),
          },
        }),
      t('admin.support.granted'),
    );
    if (ok) {
      setV({ staffId: '', accessLevel: 'read', hours: '24', reason: '' });
      grants.reload();
    }
  }

  const durationLabel = (h: number) =>
    h % 24 === 0 ? formatUnit(h / 24, 'day', locale) : formatUnit(h, 'hour', locale);

  return (
    <>
      <PageHeader title={t('admin.section.supportAccess.title')} lead={t('admin.support.lead')} />
      {canManage ? (
        <SettingsCard
          id="support-grant"
          title={t('admin.support.grantTitle')}
          description={t('admin.support.grantBody')}
        >
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                id="support-staff"
                label={t('admin.support.staffId')}
                hint={t('admin.support.staffIdHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    required
                    pattern={UUID}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    value={v.staffId}
                    onChange={(e) => setV({ ...v, staffId: e.target.value })}
                  />
                )}
              </Field>
              <Field id="support-hours" label={t('admin.support.duration')}>
                {(p) => (
                  <select
                    {...p}
                    className={selectClass}
                    value={v.hours}
                    onChange={(e) => setV({ ...v, hours: e.target.value })}
                  >
                    {DURATIONS.map((h) => (
                      <option key={h} value={h}>
                        {durationLabel(h)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <RadioGroup
              name="support-level"
              legend={t('admin.support.level')}
              value={v.accessLevel}
              onChange={(accessLevel) => setV({ ...v, accessLevel })}
              options={[
                {
                  value: 'read',
                  label: t('admin.support.levelRead'),
                  hint: t('admin.support.levelReadHint'),
                },
                {
                  value: 'read_write',
                  label: t('admin.support.levelWrite'),
                  hint: t('admin.support.levelWriteHint'),
                },
              ]}
            />
            <Field id="support-reason" label={t('admin.support.reason')} hint={t('admin.support.reasonHint')}>
              {(p) => (
                <Textarea
                  {...p}
                  required
                  minLength={3}
                  maxLength={500}
                  value={v.reason}
                  onChange={(e) => setV({ ...v, reason: e.target.value })}
                />
              )}
            </Field>
            <FormError message={grant.error} />
            <Button type="submit" className="self-start" loading={grant.busy}>
              <LifeBuoy aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('admin.support.grant')}
            </Button>
          </form>
        </SettingsCard>
      ) : (
        <ReadOnlyNote />
      )}
      <SettingsCard
        id="support-list"
        title={t('admin.support.listTitle')}
        description={t('admin.support.listBody')}
      >
        {!grants.data ? (
          <Skeleton className="h-24" />
        ) : grants.data.length === 0 ? (
          <EmptyState level={sec.level} icon={<LifeBuoy aria-hidden />} title={t('admin.support.none')} />
        ) : (
          <Table dense scrollLabel={t('admin.tableScroll', { name: t('admin.support.listTitle') })}>
            <THead>
              <tr>
                <TH>{t('admin.support.staffId')}</TH>
                <TH>{t('admin.support.level')}</TH>
                <TH>{t('admin.support.reason')}</TH>
                <TH>{t('admin.support.window')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {grants.data.map((g) => {
                const status = statusOf(g, now);
                return (
                  <TR key={g.id}>
                    <TD className="font-mono text-footnote">{g.staffId}</TD>
                    <TD>
                      {g.accessLevel === 'read'
                        ? t('admin.support.levelRead')
                        : t('admin.support.levelWrite')}
                    </TD>
                    <TD className="break-words">{g.reason}</TD>
                    <TD className="whitespace-nowrap">
                      {fmt.dateTime(g.startsAt)} – {fmt.dateTime(g.expiresAt)}
                    </TD>
                    <TD>
                      <Badge tone={status === 'active' ? 'success' : 'neutral'}>
                        {t(`admin.support.status.${status}`)}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      {canManage && status === 'active' ? (
                        <ConfirmAction
                          label={t('admin.revoke')}
                          ariaLabel={t('admin.support.revokeLabel', { staff: g.staffId })}
                          title={t('admin.support.revokeTitle')}
                          body={t('admin.support.revokeBody')}
                          confirmLabel={t('admin.revoke')}
                          onConfirm={async () => {
                            await api(`/v1/settings/support-grants/${g.id}`, { method: 'DELETE' });
                            grants.reload();
                          }}
                        />
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </SettingsCard>
    </>
  );
}
