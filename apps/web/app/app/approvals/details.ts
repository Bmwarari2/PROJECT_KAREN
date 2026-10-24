'use client';
import { formatDate, numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';

/** Fields shown first, in this order; others follow. */
const DETAIL_ORDER = [
  'leaveType',
  'startDate',
  'endDate',
  'amountDays',
  'date',
  'weekStart',
  'effectiveDate',
];
const order = (k: string) => (DETAIL_ORDER.includes(k) ? DETAIL_ORDER.indexOf(k) : DETAIL_ORDER.length);

/**
 * A request's details in words (the approvals list and a request's page): known fields with their
 * labels, dates formatted, internal ids left out.
 */
export function useApprovalDetails() {
  const t = useT();
  const locale = useLocale();
  const known = (key: string) => (t(key) === key ? null : t(key));
  return (payload: Record<string, unknown>): Array<{ key: string; label: string; value: string }> =>
    Object.entries(payload)
      .filter(([k]) => k !== 'reason' && !k.startsWith('__') && !/Id$/.test(k))
      .map(([k, v]) => [k, known(`admin.approvals.field.${k}`) ?? known(`people.field.${k}`), v] as const)
      .filter((e): e is readonly [string, string, unknown] => !!e[1])
      .sort(([a], [b]) => order(a) - order(b))
      .map(([k, label, v]) => ({
        key: k,
        label,
        value:
          k === 'leaveType' && typeof v === 'string'
            ? (known(`timeOff.kind.${v}`) ?? v)
            : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
              ? formatDate(v, locale)
              : Array.isArray(v)
                ? numberFormat(locale).format(v.length)
                : typeof v === 'number'
                  ? numberFormat(locale).format(v)
                  : String(v),
      }));
}
