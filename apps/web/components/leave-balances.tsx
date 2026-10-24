'use client';
import { Badge, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';

export interface LeaveBalance {
  leaveType: string;
  policy: string;
  unit: 'days' | 'hours';
  entitlement: number;
  carriedOver: number;
  adjustments: number;
  publicHolidays: number;
  taken: number;
  booked: number;
  pending: number;
  available: number;
  inWaitingPeriod: boolean;
}

/** One employee's balances per leave type, with the policy that produced each. */
export function LeaveBalancesTable({
  balances,
  typeName,
  caption,
}: {
  balances: LeaveBalance[];
  typeName: (key: string) => string;
  caption: string;
}) {
  const t = useT();
  const locale = useLocale();
  const amount = (b: LeaveBalance, v: number) => formatUnit(v, b.unit === 'hours' ? 'hour' : 'day', locale);
  return (
    <Table dense scrollLabel={caption}>
      <caption className="sr-only">{caption}</caption>
      <THead>
        <tr>
          <TH>{t('timeOff.type')}</TH>
          <TH>{t('admin.balances.policy')}</TH>
          <TH className="text-right">{t('timeOff.entitlement')}</TH>
          <TH className="text-right">{t('timeOff.carriedOver')}</TH>
          <TH className="text-right">{t('admin.balances.adjustments')}</TH>
          <TH className="text-right">{t('timeOff.taken')}</TH>
          <TH className="text-right">{t('timeOff.booked')}</TH>
          <TH className="text-right">{t('admin.balances.available')}</TH>
        </tr>
      </THead>
      <tbody>
        {balances.map((b) => (
          <TR key={b.leaveType}>
            <TD className="font-semibold">{typeName(b.leaveType)}</TD>
            <TD>
              {b.policy}
              {b.inWaitingPeriod ? (
                <Badge tone="warning" className="ml-2">
                  {t('admin.balances.waiting')}
                </Badge>
              ) : null}
            </TD>
            <TD className="text-right" phone="inline" label={t('timeOff.entitlement')}>
              {amount(b, b.entitlement)}
            </TD>
            <TD className="text-right" phone="inline" label={t('timeOff.carriedOver')}>
              {amount(b, b.carriedOver)}
            </TD>
            <TD className="text-right" phone="inline" label={t('admin.balances.adjustments')}>
              {amount(b, b.adjustments)}
            </TD>
            <TD className="text-right" phone="inline" label={t('timeOff.taken')}>
              {amount(b, b.taken)}
            </TD>
            <TD className="text-right" phone="inline" label={t('timeOff.booked')}>
              {amount(b, b.booked + b.pending)}
            </TD>
            <TD
              className="text-right font-semibold"
              label={t('admin.balances.available')}
              data-testid={`balance-${b.leaveType}`}
            >
              {amount(b, b.available)}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
