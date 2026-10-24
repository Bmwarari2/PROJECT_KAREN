'use client';
import * as React from 'react';
import { Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatHours } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { dayLong } from '@/lib/week';
import { FindingList, type FindingDto } from '@/components/findings';

export interface Timesheet {
  id: string | null;
  status: string;
  weekStart: string;
  days: Array<{
    date: string;
    workedMinutes: number;
    scheduledMinutes: number;
    varianceMinutes: number;
    flagged: boolean;
  }>;
  workedMinutes: number;
  scheduledMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  doubleMinutes: number;
  violations: FindingDto[];
  timeRecordingRequired: boolean;
  timeRecordingJurisdiction: string | null;
  optedOut: boolean;
  openClock: boolean;
}

export const tone = {
  open: 'neutral',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
} as const;

export function Hours({ minutes, signed }: { minutes: number; signed?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const v = formatHours(Math.abs(minutes), locale);
  return (
    <>{t('timesheets.hours', { hours: signed && minutes !== 0 ? `${minutes > 0 ? '+' : '−'}${v}` : v })}</>
  );
}

/** A week's days, totals, overtime split and working-time findings (my week, and a timesheet's page). */
export function WeekBody({ d, label }: { d: Timesheet; label: string }) {
  const t = useT();
  const locale = useLocale();
  return (
    <>
      <Table dense scrollLabel={label}>
        <THead>
          <tr>
            <TH>{t('timesheets.day')}</TH>
            <TH className="text-right">{t('timesheets.scheduled')}</TH>
            <TH className="text-right">{t('timesheets.worked')}</TH>
            <TH className="text-right">{t('timesheets.variance')}</TH>
          </tr>
        </THead>
        <tbody>
          {d.days.map((day) => (
            <TR key={day.date} className={day.flagged ? 'bg-accent-subtle' : undefined}>
              <TD>{dayLong(day.date, locale)}</TD>
              <TD className="text-right" label={t('timesheets.scheduled')} phone="inline">
                <Hours minutes={day.scheduledMinutes} />
              </TD>
              <TD className="text-right" label={t('timesheets.worked')} phone="inline">
                <Hours minutes={day.workedMinutes} />
              </TD>
              <TD
                className={`text-right ${day.flagged ? 'font-semibold text-warning' : 'text-text-secondary'}`}
                label={t('timesheets.variance')}
                phone="inline"
              >
                <Hours minutes={day.varianceMinutes} signed />
                {day.flagged ? <span className="sr-only"> {t('timesheets.flagged')}</span> : null}
              </TD>
            </TR>
          ))}
          <TR>
            <TD className="font-semibold">{t('timesheets.total')}</TD>
            <TD className="text-right font-semibold" label={t('timesheets.scheduled')} phone="inline">
              <Hours minutes={d.scheduledMinutes} />
            </TD>
            <TD className="text-right font-semibold" label={t('timesheets.worked')} phone="inline">
              <Hours minutes={d.workedMinutes} />
            </TD>
            <TD className="text-right font-semibold" label={t('timesheets.variance')} phone="inline">
              <Hours minutes={d.workedMinutes - d.scheduledMinutes} signed />
            </TD>
          </TR>
        </tbody>
      </Table>
      <dl className="grid grid-cols-3 gap-3 text-callout">
        {(
          [
            ['regular', d.regularMinutes],
            ['overtime', d.overtimeMinutes],
            ['double', d.doubleMinutes],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-md bg-surface p-3">
            <dt className="text-footnote text-text-secondary">{t(`timesheets.${k}`)}</dt>
            <dd className="whitespace-nowrap text-title-3 tabular-nums" data-testid={`ts-${k}`}>
              <Hours minutes={v} />
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="mb-2 text-callout font-semibold">{t('timesheets.findings')}</h3>
        {d.violations.length ? (
          <FindingList findings={d.violations} />
        ) : (
          <p className="text-callout text-text-secondary">{t('timesheets.noFindings')}</p>
        )}
        {d.timeRecordingRequired ? (
          <p className="mt-2 text-footnote text-text-secondary">
            {t('timesheets.recordingRequired', { jurisdiction: d.timeRecordingJurisdiction ?? '' })}
          </p>
        ) : null}
        {d.optedOut ? (
          <p className="mt-2 text-footnote text-text-secondary">{t('timesheets.optedOut')}</p>
        ) : null}
        {d.openClock ? <p className="mt-2 text-footnote text-warning">{t('timesheets.openClock')}</p> : null}
      </div>
    </>
  );
}
