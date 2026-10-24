'use client';
import * as React from 'react';
import { Coffee, Copy, KeyRound, LogIn, LogOut, MapPin, Monitor, RefreshCw, WifiOff } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton, useToast, PageSection } from '@thapsus/ui';
import { nowInstant } from '@thapsus/core/time';
import { formatDateTime, formatInstantTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import {
  enqueue,
  newClientEventId,
  projectState,
  readQueue,
  syncQueue,
  type ClockKind,
  type ClockState,
  type QueuedPunch,
} from '@/lib/clock-queue';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { PageIntro } from '@/components/module-page';
import { hasPermission, useSession } from '../shell';

interface Status {
  employeeId: string | null;
  state: ClockState;
  zone: string | null;
  geofence: { enabled: boolean; notice: string | null };
  today: Array<{
    id: string;
    kind: string;
    occurredAt: string;
    source: string;
    withinGeofence: boolean | null;
    superseded: boolean;
  }>;
}

/** Location is requested only when the tenant enabled geofencing for this worker (and they were told). */
function currentPosition(): Promise<{ lat: number; lng: number } | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    ),
  );
}

function ClockCard({ userId }: { userId: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const [status, setStatus] = React.useState<Status | null>(null);
  const [queue, setQueue] = React.useState<QueuedPunch[]>([]);
  const [online, setOnline] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api<Status>('/v1/clock/status'));
    } catch {
      /* offline: keep the last known status */
    }
  }, []);
  const sync = React.useCallback(async () => {
    let r = await syncQueue(userId);
    // a punch made while a batch was in flight goes in the next batch
    if (r && readQueue(userId).length) r = (await syncQueue(userId)) ?? r;
    setQueue(readQueue(userId));
    if (r) {
      const rejected = r.results.filter((x) => x.status === 'rejected');
      if (rejected.length) toast({ title: t('clock.rejected', { count: rejected.length }), tone: 'danger' });
      await refresh();
    }
  }, [userId, refresh, t, toast]);

  React.useEffect(() => {
    setQueue(readQueue(userId));
    setOnline(navigator.onLine);
    void refresh().then(sync);
    const on = () => {
      setOnline(true);
      void sync();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [userId, refresh, sync]);

  const shown = projectState(status?.state ?? { state: 'out', since: null }, queue);
  async function punch(kind: ClockKind) {
    setBusy(true);
    try {
      const location = status?.geofence.enabled ? await currentPosition() : undefined;
      const p: QueuedPunch = {
        clientEventId: newClientEventId(),
        kind,
        occurredAt: nowInstant(),
        zone,
        ...(location ? { location } : {}),
      };
      setQueue(enqueue(userId, p));
      toast({
        title: t('clock.recorded', {
          kind: t(`clock.kind.${kind}`),
          time: formatInstantTime(p.occurredAt, locale, zone),
        }),
        tone: 'success',
      });
      if (navigator.onLine) await sync();
    } finally {
      setBusy(false);
    }
  }

  const since = shown.since ? formatInstantTime(shown.since, locale, zone) : '';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        {!online ? (
          <p role="status" className="mb-4 flex items-start gap-2 rounded-md bg-surface p-3 text-callout">
            <WifiOff aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
            {t('clock.offline')}
          </p>
        ) : null}
        <p className="text-title-3" aria-live="polite" data-testid="clock-state">
          {shown.state === 'out'
            ? t('clock.stateOut')
            : shown.state === 'in'
              ? t('clock.stateIn', { time: since })
              : t('clock.stateBreak', { time: since })}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {shown.state === 'out' ? (
            <Button size="lg" onClick={() => punch('in')} loading={busy}>
              <LogIn aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.in')}
            </Button>
          ) : null}
          {shown.state === 'in' ? (
            <>
              <Button size="lg" onClick={() => punch('out')} loading={busy}>
                <LogOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
                {t('clock.out')}
              </Button>
              <Button size="lg" variant="secondary" onClick={() => punch('break_start')} disabled={busy}>
                <Coffee aria-hidden className="h-5 w-5 stroke-[1.5]" />
                {t('clock.breakStart')}
              </Button>
            </>
          ) : null}
          {shown.state === 'break' ? (
            <Button size="lg" onClick={() => punch('break_end')} loading={busy}>
              <Coffee aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.breakEnd')}
            </Button>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-footnote text-text-secondary">
          {queue.length ? (
            <>
              <Badge tone="warning" data-testid="clock-queued">
                {t('clock.queued', { count: queue.length })}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => sync()} disabled={!online}>
                <RefreshCw aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('clock.syncNow')}
              </Button>
            </>
          ) : (
            <span data-testid="clock-synced">{t('clock.allSynced')}</span>
          )}
        </div>
        {status?.geofence.enabled ? (
          <div
            className="mt-5 flex items-start gap-2 rounded-md bg-surface p-3 text-callout"
            data-testid="geofence-notice"
          >
            <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
            <div>
              <p className="font-semibold">{t('clock.geofenceTitle')}</p>
              <p>{status.geofence.notice}</p>
              <p className="mt-1 text-footnote text-text-secondary">{t('clock.geofenceWhen')}</p>
            </div>
          </div>
        ) : null}
      </Card>
      <PageSection headingLevel={2} title={t('clock.recent')}>
        <Card>
          {!status ? (
            <Skeleton className="mt-3 h-24" />
          ) : status.today.length || queue.length ? (
            <ul className="mt-3 flex flex-col gap-2">
              {queue.map((p) => (
                <li key={p.clientEventId} className="flex items-center justify-between gap-2 text-callout">
                  <span>{t(`clock.kind.${p.kind}`)}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <Badge tone="warning">{t('clock.waiting')}</Badge>
                    {formatInstantTime(p.occurredAt, locale, zone)}
                  </span>
                </li>
              ))}
              {[...status.today].reverse().map((e) => (
                <li
                  key={e.id}
                  className={`flex items-center justify-between gap-2 text-callout ${e.superseded ? 'line-through text-text-secondary' : ''}`}
                >
                  <span>{t(`clock.kind.${e.kind}`)}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {e.source !== 'pwa' ? <Badge>{t(`clock.source.${e.source}`)}</Badge> : null}
                    {e.withinGeofence === false ? (
                      <Badge tone="warning">{t('clock.outsideSite')}</Badge>
                    ) : null}
                    {formatInstantTime(e.occurredAt, locale, zone)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-callout text-text-secondary">{t('clock.none')}</p>
          )}
        </Card>
      </PageSection>
    </div>
  );
}

function PinCard({ employeeId }: { employeeId: string }) {
  const t = useT();
  const toast = useToast();
  const [pin, setPin] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/kiosk-pins/${employeeId}`, { method: 'PUT', json: { pin } });
      setPin('');
      toast({ title: t('clock.pinSaved'), tone: 'success' });
    } catch (err) {
      toast({
        title: err instanceof ApiProblem && err.status === 422 ? t('clock.pinWeak') : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageSection headingLevel={2} title={t('clock.pinTitle')} description={t('clock.pinBody')}>
      <Card>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <Field id="kiosk-pin" label={t('clock.pinLabel')}>
            {(p) => (
              <Input
                {...p}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="\d{4,8}"
                minLength={4}
                maxLength={8}
                required
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="w-40"
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" loading={busy}>
            <KeyRound aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('clock.pinSave')}
          </Button>
        </form>
      </Card>
    </PageSection>
  );
}

function KiosksCard() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const kiosks =
    useApi<Array<{ id: string; name: string; lastUsedAt: string | null; revokedAt: string | null }>>(
      '/v1/kiosks',
    );
  const locations = useApi<Array<{ id: string; name: string }>>('/v1/org/locations');
  const [name, setName] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const [link, setLink] = React.useState<string | null>(null);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await api<{ token: string }>('/v1/kiosks', {
      method: 'POST',
      json: { name, locationId: locationId || null },
    });
    setLink(`${window.location.origin}/kiosk#pair=${r.token}`);
    setName('');
    kiosks.reload();
  }
  return (
    <PageSection headingLevel={2} title={t('clock.kiosksTitle')} className="lg:col-span-2">
      <Card>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <Field id="kiosk-name" label={t('clock.kioskName')}>
            {(p) => (
              <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field id="kiosk-location" label={t('rota.location')}>
            {(p) => (
              <select
                {...p}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
              >
                <option value="">{t('rota.allLocations')}</option>
                {(locations.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button type="submit" variant="secondary">
            <Monitor aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('clock.kioskAdd')}
          </Button>
        </form>
        {link ? (
          <div role="status" className="mt-3 rounded-md bg-surface p-3 text-callout">
            <p className="font-semibold">{t('clock.kioskLinkOnce')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="max-w-full break-all text-footnote" data-testid="kiosk-link">
                {link}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await navigator.clipboard?.writeText(link).catch(() => undefined);
                  toast({ title: t('clock.copied') });
                }}
              >
                <Copy aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('clock.copy')}
              </Button>
            </div>
          </div>
        ) : null}
        <ul className="mt-4 flex flex-col divide-y divide-border">
          {(kiosks.data ?? []).map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-callout">
              <span className="font-semibold">{k.name}</span>
              <span className="flex items-center gap-2 text-footnote text-text-secondary">
                {t('clock.lastUsed')}:{' '}
                {k.lastUsedAt ? formatDateTime(k.lastUsedAt, locale, zone) : t('clock.never')}
                {k.revokedAt ? (
                  <Badge>{t('clock.revoked')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api(`/v1/kiosks/${k.id}/revoke`, { method: 'POST' });
                      kiosks.reload();
                    }}
                  >
                    {t('clock.revoke')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}

export default function ClockPage() {
  const t = useT();
  const session = useSession();
  if (!session) return null;
  const canManage = hasPermission(session, 'time.manage');
  return (
    <div className="flex flex-col gap-5">
      <PageIntro title={t('clock.title')} titleIsTab />
      {session.employeeId ? (
        <ClockCard userId={session.userId} />
      ) : (
        <EmptyState title={t('clock.noEmployee')} />
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {session.employeeId ? <PinCard employeeId={session.employeeId} /> : null}
        {canManage ? <KiosksCard /> : null}
      </div>
    </div>
  );
}
