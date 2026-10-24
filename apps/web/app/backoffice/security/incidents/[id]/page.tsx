'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Building2, History, Radar, ShieldOff } from 'lucide-react';
import { Button, Card, CardTitle, Field, ListItem, ListSection, Skeleton, Textarea } from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass, useStaffApi } from '../../../ui';
import { SecurityNav, SeverityBadge, useRun } from '../../nav';
import type { IncidentRow } from '../page';

interface Detail {
  incident: IncidentRow;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  tenants: Array<{ tenantId: string; slug: string | null }>;
  detections: Array<{
    id: string;
    ruleId: string;
    severity: string;
    firstSeenAt: string;
    lastSeenAt: string;
    eventCount: number;
    tenantId: string | null;
    actorId: string | null;
    actorType: string | null;
    staffId: string | null;
    ipNet: string | null;
  }>;
  timeline: Array<{
    id: string;
    at: string;
    kind: string;
    staff: string | null;
    body: string | null;
    detail: { ruleId?: string; kind?: string; to?: string };
  }>;
  containment: Array<{
    id: string;
    kind: string;
    automated: boolean;
    createdAt: string;
    expiresAt: string | null;
    reversedAt: string | null;
    reversalRequested: boolean;
    active: boolean;
  }>;
  actions: string[];
}
const STATUSES = ['open', 'acknowledged', 'contained', 'resolved', 'false_positive'];
const short = (id: string) => id.slice(0, 8);

/**
 * One incident (ADR-0177, ADR-0178): its detections, the workspaces it touches, containment with reversal
 * (a frozen staff account needs a second person), status and owner, and the timeline with notes.
 */
export default function IncidentPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const { id } = useParams<{ id: string }>();
  const d = useApi<Detail>(`/v1/backoffice/security/incidents/${id}`);
  const analysts = useApi<Array<{ id: string; displayName: string }>>('/v1/backoffice/security/analysts');
  const { busy, run } = useRun();
  // re-authentication with the staff key when the API asks for it (ADR-0173)
  const securityCall = useStaffApi();
  const [status, setStatus] = React.useState<string | null>(null);
  const [assignee, setAssignee] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');

  if (!d.data) return <Skeleton className="h-64 w-full" />;
  const x = d.data;
  const inc = x.incident;
  const rule = (r: string) => t(`backoffice.security.rules.${r}.name`);
  const currentStatus = status ?? inc.status;
  const currentAssignee = assignee ?? inc.assignedTo?.id ?? '';

  const save = () =>
    run(
      'save',
      () =>
        securityCall(`/v1/backoffice/security/incidents/${id}`, {
          method: 'PATCH',
          json: {
            ...(currentStatus !== inc.status ? { status: currentStatus } : {}),
            ...(currentAssignee !== (inc.assignedTo?.id ?? '')
              ? { assignedTo: currentAssignee || null }
              : {}),
          },
        }),
      t('backoffice.security.incident.saved'),
    ).then(() => d.reload());
  const contain = (kind: string) =>
    run(
      kind,
      () =>
        securityCall<{ id: string | null; skipped: string | null }>(
          `/v1/backoffice/security/incidents/${id}/containment`,
          { method: 'POST', json: { kind } },
        ),
      (r) =>
        r.skipped
          ? t('backoffice.security.incident.skipped', {
              reason: t(`backoffice.security.incident.skipReason.${r.skipped}`),
            })
          : t(`backoffice.security.containmentDone.${kind}`),
    ).then(() => d.reload());
  const reverse = (actionId: string) =>
    run(
      `reverse-${actionId}`,
      () =>
        securityCall<{ state: string }>(`/v1/backoffice/security/containment/${actionId}/reverse`, {
          method: 'POST',
        }),
      (r) =>
        r.state === 'reversed'
          ? t('backoffice.security.incident.reversedToast')
          : t('backoffice.security.incident.awaitingToast'),
    ).then(() => d.reload());
  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    const ok = await run(
      'note',
      () =>
        securityCall(`/v1/backoffice/security/incidents/${id}/notes`, {
          method: 'POST',
          json: { body: note },
        }),
      t('backoffice.security.incident.noteSaved'),
    );
    if (ok !== undefined) {
      setNote('');
      d.reload();
    }
  };
  const subject = (det: Detail['detections'][number]) =>
    [
      det.tenantId ? t('backoffice.security.incident.workspace', { id: short(det.tenantId) }) : null,
      det.actorId
        ? det.actorType === 'api_client'
          ? t('backoffice.security.incident.apiKey', { id: short(det.actorId) })
          : t('backoffice.security.incident.person', { id: short(det.actorId) })
        : null,
      det.staffId ? t('backoffice.security.incident.staffMember', { id: short(det.staffId) }) : null,
      det.ipNet ? t('backoffice.security.incident.network', { net: det.ipNet }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const eventTitle = (e: Detail['timeline'][number]) =>
    t(`backoffice.security.incident.event.${e.kind}`, {
      rule: e.detail.ruleId ? rule(e.detail.ruleId) : '',
      kind: e.detail.kind ? t(`backoffice.security.containment.${e.detail.kind}`) : '',
      to: e.detail.to ? t(`backoffice.security.status.${e.detail.to}`) : '',
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link href="/backoffice/security/incidents" className="inline-flex items-center gap-1 text-callout">
          <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('backoffice.security.incident.back')}
        </Link>
        <PageTitle
          title={`${inc.reference} · ${rule(inc.ruleId)}`}
          lead={t('backoffice.security.incident.lead', {
            severity: t(`backoffice.security.severity.${inc.severity}`),
            status: t(`backoffice.security.status.${inc.status}`),
            first: when(inc.firstSeenAt),
            last: when(inc.lastSeenAt),
          })}
        >
          <SeverityBadge severity={inc.severity} />
        </PageTitle>
        <SecurityNav />
      </div>

      <Card>
        <CardTitle>{t('backoffice.security.incident.manage')}</CardTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field id="incident-status" label={t('backoffice.security.incident.statusLabel')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={currentStatus}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`backoffice.security.status.${s}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="incident-assignee" label={t('backoffice.security.incident.assignee')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={currentAssignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">{t('backoffice.security.incident.nobody')}</option>
                {(analysts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button onClick={save} loading={busy === 'save'}>
            {t('backoffice.security.incident.save')}
          </Button>
        </div>
      </Card>

      <ListSection
        id="containment"
        title={t('backoffice.security.incident.actions')}
        footer={t('backoffice.security.incident.actionsHint')}
      >
        {x.actions.length ? (
          x.actions.map((k) => (
            <ListItem
              key={k}
              leading={<ShieldOff aria-hidden />}
              title={t(`backoffice.security.containment.${k}`)}
              actions={
                <Button size="sm" variant="secondary" loading={busy === k} onClick={() => contain(k)}>
                  {t('backoffice.security.incident.apply')}
                </Button>
              }
            />
          ))
        ) : (
          <ListItem title={t('backoffice.security.incident.noActions')} />
        )}
        {x.containment.map((c) => (
          <ListItem
            key={c.id}
            leading={<ShieldOff aria-hidden />}
            title={`${t('backoffice.security.incident.appliedList')}: ${t(`backoffice.security.containment.${c.kind}`)}`}
            subtitle={[
              c.automated
                ? t('backoffice.security.incident.automated')
                : t('backoffice.security.incident.manual'),
              when(c.createdAt),
              c.reversedAt
                ? t('backoffice.security.incident.reversed', { at: when(c.reversedAt) })
                : c.expiresAt
                  ? t('backoffice.security.incident.expires', { at: when(c.expiresAt) })
                  : null,
              c.reversalRequested && !c.reversedAt ? t('backoffice.security.incident.awaitingSecond') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            actions={
              c.active ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `reverse-${c.id}`}
                  onClick={() => reverse(c.id)}
                >
                  {c.kind === 'freeze_staff' && c.reversalRequested
                    ? t('backoffice.security.incident.approveReverse')
                    : t('backoffice.security.incident.reverse')}
                </Button>
              ) : undefined
            }
          />
        ))}
      </ListSection>

      <ListSection id="detections" title={t('backoffice.security.incident.detections')}>
        {x.detections.map((det) => (
          <ListItem
            key={det.id}
            leading={<Radar aria-hidden />}
            title={rule(det.ruleId)}
            subtitle={
              <>
                <span className="block">
                  {t('backoffice.security.incident.detectionLine', {
                    events: t('backoffice.security.incidents.events', { count: det.eventCount }),
                    first: when(det.firstSeenAt),
                    last: when(det.lastSeenAt),
                  })}
                </span>
                {subject(det) ? <span className="block">{subject(det)}</span> : null}
              </>
            }
            accessory={<SeverityBadge severity={det.severity} />}
          />
        ))}
      </ListSection>

      <ListSection id="affected" title={t('backoffice.security.incident.affected')}>
        {x.tenants.length ? (
          x.tenants.map((w) => (
            <ListItem
              key={w.tenantId}
              href={`/backoffice/tenants/${w.tenantId}`}
              linkAs={Link}
              leading={<Building2 aria-hidden />}
              title={w.slug ?? short(w.tenantId)}
            />
          ))
        ) : (
          <ListItem title={t('backoffice.security.incident.noAffected')} />
        )}
      </ListSection>

      <ListSection id="timeline" title={t('backoffice.security.incident.timeline')}>
        {x.timeline.map((e) => (
          <ListItem
            key={e.id}
            leading={<History aria-hidden />}
            title={eventTitle(e)}
            subtitle={e.body ?? undefined}
            meta={`${when(e.at)} · ${e.staff ? t('backoffice.security.incident.by', { name: e.staff }) : t('backoffice.security.incident.system')}`}
          />
        ))}
      </ListSection>

      <Card>
        <form onSubmit={addNote} className="flex flex-col gap-3">
          <CardTitle>{t('backoffice.security.incident.addNote')}</CardTitle>
          <Field
            id="incident-note"
            label={t('backoffice.security.incident.noteLabel')}
            hint={t('backoffice.security.incident.noteHint')}
          >
            {(p) => (
              <Textarea
                {...p}
                value={note}
                maxLength={2000}
                rows={3}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" className="self-start" loading={busy === 'note'} disabled={!note.trim()}>
            {t('backoffice.security.incident.addNote')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
