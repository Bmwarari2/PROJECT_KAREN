'use client';
import * as React from 'react';
import {
  Activity,
  AlertOctagon,
  Clock,
  Fingerprint,
  KeyRound,
  Lock,
  LogIn,
  Network,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import Link from 'next/link';
import { BarList, Button, KpiTile, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDateTime, numberFormat, type Locale } from '@thapsus/core/i18n';
import { Panel } from '@/components/dashboard/parts';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { DashboardSection } from '../charts';
import { PageTitle, useStaff, useStaffApi } from '../ui';
import { SecurityNav, useRun } from './nav';

interface Overview {
  cell: string;
  detections24h: Array<{ severity: string; count: number }>;
  openIncidents: Array<{ severity: string; count: number }>;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  auth: {
    signIns: number;
    failures: number;
    failureRateBasisPoints: number | null;
    lockouts: number;
    users: number;
    usersWithMfa: number;
  };
  topIps: Array<{
    ipKey: string;
    ipNet: string | null;
    events: number;
    lastSeenAt: string;
    blocked: boolean;
  }>;
  elevations: Array<{ at: string; action: string; staff: string | null; scope: string | null }>;
  pipeline: { ranAt: string | null; stale: boolean; waitingEvents: number; staffRecipients: number };
}

/**
 * The Security module's overview (ADR-0177): detections in the last day, open incidents with mean time to
 * acknowledge and resolve, this region's sign-in health, the top offending address ranges, the staff
 * elevation log and the state of the detection pipeline.
 */
export default function SecurityOverview() {
  const t = useT();
  const locale = useLocale() as Locale;
  const staff = useStaff();
  const o = useApi<Overview>('/v1/backoffice/security/overview');
  const { busy, run } = useRun();
  // re-authentication with the staff key when the API asks for it (ADR-0173)
  const securityCall = useStaffApi();
  const n = (v: number) => numberFormat(locale).format(v);
  const pct = (bp: number) =>
    numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000);
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');
  const count = (list: Overview['detections24h'], s: string) =>
    list.find((x) => x.severity === s)?.count ?? 0;
  const sum = (list: Overview['detections24h']) => list.reduce((a, x) => a + x.count, 0);
  const minutes = (v: number | null) =>
    v === null
      ? t('backoffice.security.overview.none')
      : t('backoffice.security.overview.minutes', { value: n(v) });

  async function runNow() {
    if (
      (await run(
        'run',
        () => securityCall('/v1/backoffice/security/run', { method: 'POST' }),
        t('backoffice.security.overview.ran'),
      )) !== undefined
    )
      o.reload();
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageTitle title={t('backoffice.security.title')} lead={t('backoffice.security.lead')} />
        <SecurityNav />
      </div>
      {!o.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label={t('backoffice.security.overview.detections')}
              value={n(sum(o.data.detections24h))}
              hint={t('backoffice.security.overview.detectionsHint', {
                critical: n(count(o.data.detections24h, 'critical')),
                high: n(count(o.data.detections24h, 'high')),
              })}
              icon={<Radar aria-hidden />}
            />
            <KpiTile
              label={t('backoffice.security.overview.open')}
              value={n(sum(o.data.openIncidents))}
              hint={t('backoffice.security.overview.openHint', {
                critical: n(count(o.data.openIncidents, 'critical')),
                high: n(count(o.data.openIncidents, 'high')),
              })}
              icon={<ShieldAlert aria-hidden />}
              href="/backoffice/security/incidents"
              linkAs={Link}
            />
            <KpiTile
              label={t('backoffice.security.overview.mtta')}
              value={minutes(o.data.mttaMinutes)}
              hint={t('backoffice.security.overview.mttHint')}
              icon={<Clock aria-hidden />}
            />
            <KpiTile
              label={t('backoffice.security.overview.mttr')}
              value={minutes(o.data.mttrMinutes)}
              hint={t('backoffice.security.overview.mttHint')}
              icon={<Timer aria-hidden />}
            />
          </div>

          <Panel level={2} title={t('backoffice.security.overview.bySeverity')}>
            <BarList
              items={[...o.data.detections24h].reverse().map((d) => ({
                label: t(`backoffice.security.severity.${d.severity}`),
                value: d.count,
              }))}
              label={t('backoffice.security.overview.bySeverity')}
              format={n}
            />
          </Panel>

          <DashboardSection
            id="auth"
            title={t('backoffice.security.overview.authTitle', { region: t(`regions.${o.data.cell}`) })}
            footer={`${t('backoffice.security.overview.authHint')} ${t('backoffice.security.overview.otherRegions')}`}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label={t('backoffice.security.overview.signIns')}
                value={n(o.data.auth.signIns)}
                icon={<LogIn aria-hidden />}
              />
              <KpiTile
                label={t('backoffice.security.overview.failures')}
                value={n(o.data.auth.failures)}
                hint={
                  o.data.auth.failureRateBasisPoints === null
                    ? undefined
                    : t('backoffice.security.overview.failureRate', {
                        rate: pct(o.data.auth.failureRateBasisPoints),
                      })
                }
                icon={<AlertOctagon aria-hidden />}
              />
              <KpiTile
                label={t('backoffice.security.overview.lockouts')}
                value={n(o.data.auth.lockouts)}
                icon={<Lock aria-hidden />}
              />
              <KpiTile
                label={t('backoffice.security.overview.mfa')}
                value={
                  o.data.auth.users
                    ? pct(Math.round((o.data.auth.usersWithMfa * 10000) / o.data.auth.users))
                    : t('backoffice.security.overview.none')
                }
                hint={t('backoffice.security.overview.mfaHint', {
                  withMfa: n(o.data.auth.usersWithMfa),
                  users: n(o.data.auth.users),
                })}
                icon={<ShieldCheck aria-hidden />}
              />
            </div>
          </DashboardSection>

          <ListSection
            id="top-ips"
            title={t('backoffice.security.overview.topIps')}
            footer={t('backoffice.security.overview.topIpsHint')}
          >
            {o.data.topIps.length ? (
              o.data.topIps.map((ip) => (
                <ListItem
                  key={ip.ipKey}
                  leading={<Network aria-hidden />}
                  title={ip.ipNet ?? t('backoffice.security.overview.unknownNetwork')}
                  subtitle={t('backoffice.security.overview.topIpEvents', { count: ip.events })}
                  meta={t('backoffice.security.overview.lastSeen', { at: when(ip.lastSeenAt) })}
                  accessory={
                    ip.blocked ? (
                      <span className="text-footnote font-semibold text-danger">
                        {t('backoffice.security.overview.blocked')}
                      </span>
                    ) : undefined
                  }
                />
              ))
            ) : (
              <ListItem title={t('backoffice.security.overview.noTopIps')} />
            )}
          </ListSection>

          <ListSection
            id="elevations"
            title={t('backoffice.security.overview.elevations')}
            description={t('backoffice.security.overview.elevationsHint')}
          >
            {o.data.elevations.length ? (
              o.data.elevations.map((e, i) => (
                <ListItem
                  key={`${e.at}-${i}`}
                  leading={<KeyRound aria-hidden />}
                  title={
                    t(`backoffice.security.overview.elevation.${e.action}`) ===
                    `backoffice.security.overview.elevation.${e.action}`
                      ? e.action
                      : t(`backoffice.security.overview.elevation.${e.action}`)
                  }
                  subtitle={[
                    e.staff,
                    e.scope ? t('backoffice.security.overview.elevationScope', { scope: e.scope }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  meta={when(e.at)}
                />
              ))
            ) : (
              <ListItem title={t('backoffice.security.overview.noElevations')} />
            )}
          </ListSection>

          <ListSection
            id="pipeline"
            title={t('backoffice.security.overview.pipeline')}
            action={
              staff ? (
                <Button size="sm" variant="secondary" loading={busy === 'run'} onClick={runNow}>
                  {t('backoffice.security.overview.runNow')}
                </Button>
              ) : null
            }
          >
            <ListItem
              leading={<Activity aria-hidden />}
              title={
                o.data.pipeline.ranAt
                  ? t('backoffice.security.overview.pipelineRan', { at: when(o.data.pipeline.ranAt) })
                  : t('backoffice.security.overview.pipelineNever')
              }
              subtitle={
                o.data.pipeline.stale
                  ? t('backoffice.security.overview.pipelineStale')
                  : t('backoffice.security.overview.pipelineWaiting', {
                      count: o.data.pipeline.waitingEvents,
                    })
              }
            />
            <ListItem
              leading={<Fingerprint aria-hidden />}
              title={
                o.data.pipeline.staffRecipients
                  ? t('backoffice.security.overview.recipients', { count: o.data.pipeline.staffRecipients })
                  : t('backoffice.security.overview.noRecipients')
              }
            />
          </ListSection>
        </>
      )}
    </div>
  );
}
