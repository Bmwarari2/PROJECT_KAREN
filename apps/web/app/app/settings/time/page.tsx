'use client';
import * as React from 'react';
import Link from 'next/link';
import { MapPin, Monitor, Pencil } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR, Textarea } from '@thapsus/ui';
import { dateTimeFormat, formatNumber, LOCALES } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ConfirmAction, FormError, PageHeader, RadioGroup, selectClass, SettingsCard, useAction, useOrg, usePermission } from '../kit';

interface TimeSettings {
  enforcement: 'warn' | 'block';
  workweekStartsOn: number;
  geofence: { countries: string[]; notice: Record<string, Record<string, string>> };
  kiosk: { maxFailedAttempts: number; lockoutMinutes: number; attemptsPerMinute: number };
  clock: { maxOfflineHours: number };
  timesheets: { varianceToleranceMinutes: number };
}
interface Location {
  id: string;
  name: string;
  country: string;
  geofence: { lat: number; lng: number; radiusMetres: number } | null;
}

const put = (body: Partial<TimeSettings>) => api<TimeSettings>('/v1/settings/time', { method: 'PUT', json: body });

function WorkingTime({ s, onSaved }: { s: TimeSettings; onSaved: () => void }) {
  const t = useT();
  const locale = useLocale();
  const action = useAction();
  const [enforcement, setEnforcement] = React.useState(s.enforcement);
  const [weekStart, setWeekStart] = React.useState(String(s.workweekStartsOn));
  // 1 January 2001 was a Monday, so day n of that week is ISO weekday n.
  const weekday = (n: number) => dateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, 0, n)));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await action.run(() => put({ enforcement, workweekStartsOn: Number(weekStart) }), t('admin.saved'))) onSaved();
  }
  return (
    <SettingsCard id="working-time" title={t('admin.time.rulesTitle')} description={t('admin.time.rulesBody')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <RadioGroup
          name="enforcement"
          legend={t('admin.time.enforcement')}
          value={enforcement}
          onChange={setEnforcement}
          options={[
            { value: 'warn', label: t('admin.time.warn'), hint: t('admin.time.warnHint') },
            { value: 'block', label: t('admin.time.block'), hint: t('admin.time.blockHint') },
          ]}
        />
        <Field id="week-start" label={t('admin.time.weekStart')} hint={t('admin.time.weekStartHint')} className="sm:w-1/2">
          {(p) => (
            <select {...p} className={selectClass} value={weekStart} onChange={(e) => setWeekStart(e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {weekday(n)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          {t('common.save')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function Geofencing({ s, onSaved }: { s: TimeSettings; onSaved: () => void }) {
  const t = useT();
  const action = useAction();
  const [country, setCountry] = React.useState('');
  const [notice, setNotice] = React.useState<Record<string, string>>({});
  const [editing, setEditing] = React.useState(false);
  const form = React.useRef<HTMLHeadingElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const code = country.trim().toUpperCase();
    const texts = Object.fromEntries(Object.entries(notice).map(([l, x]) => [l, x.trim()]).filter(([, x]) => x));
    if (!Object.keys(texts).length) {
      action.setError(t('admin.time.noticeRequired'));
      return;
    }
    const countries = [...new Set([...s.geofence.countries, code])];
    const ok = await action.run(() => put({ geofence: { countries, notice: { ...s.geofence.notice, [code]: texts } } }), t('admin.time.geofenceSaved', { country: code }));
    if (ok) {
      setCountry('');
      setNotice({});
      setEditing(false);
      onSaved();
    }
  }
  const edit = (code: string) => {
    setCountry(code);
    setNotice({ ...(s.geofence.notice[code] ?? {}) });
    setEditing(true);
    form.current?.focus();
  };
  const remove = async (code: string) => {
    const { [code]: _removed, ...rest } = s.geofence.notice;
    void _removed;
    await put({ geofence: { countries: s.geofence.countries.filter((c) => c !== code), notice: rest } });
    onSaved();
  };

  return (
    <SettingsCard id="geofencing" title={t('admin.time.geofenceTitle')} description={t('admin.time.geofenceBody')}>
      {s.geofence.countries.length === 0 ? (
        <p className="text-callout text-text-secondary">{t('admin.time.geofenceOff')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {s.geofence.countries.map((c) => (
            <li key={c} className="flex flex-col gap-2 rounded-md border border-border p-4" data-testid={`geofence-${c}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="mr-auto text-callout font-semibold">{t('admin.time.countryN', { country: c })}</h4>
                <Badge tone="success">{t('admin.on')}</Badge>
                <Button size="sm" variant="ghost" aria-label={t('admin.time.editNotice', { country: c })} onClick={() => edit(c)}>
                  <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('common.edit')}
                </Button>
                <ConfirmAction label={t('admin.turnOff')} ariaLabel={t('admin.time.turnOffLabel', { country: c })} title={t('admin.time.turnOffTitle', { country: c })} body={t('admin.time.turnOffBody')} confirmLabel={t('admin.turnOff')} onConfirm={() => remove(c)} />
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-footnote sm:grid-cols-[max-content_minmax(0,1fr)]">
                {Object.entries(s.geofence.notice[c] ?? {}).map(([l, text]) => (
                  <React.Fragment key={l}>
                    <dt className="text-text-secondary">{t(`locales.${l}`)}</dt>
                    <dd>{text}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4" aria-labelledby="geofence-form-title">
        <h4 id="geofence-form-title" ref={form} tabIndex={-1} className="text-callout font-semibold outline-none">
          {editing ? t('admin.time.editNoticeTitle', { country }) : t('admin.time.addCountry')}
        </h4>
        <Field id="geo-country" label={t('admin.time.country')} hint={t('admin.time.countryHint')}>
          {(p) => <Input {...p} required readOnly={editing} maxLength={2} pattern="[A-Za-z]{2}" autoCapitalize="characters" spellCheck={false} className="uppercase sm:w-24" value={country} onChange={(e) => setCountry(e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase())} />}
        </Field>
        {LOCALES.map((l) => (
          <Field key={l} id={`geo-notice-${l}`} label={t('admin.time.noticeIn', { locale: t(`locales.${l}`) })} hint={t('admin.time.noticeHint')}>
            {(p) => <Textarea {...p} maxLength={2000} value={notice[l] ?? ''} onChange={(e) => setNotice((n) => ({ ...n, [l]: e.target.value }))} />}
          </Field>
        ))}
        <FormError message={action.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={action.busy}>
            {editing ? t('common.save') : t('admin.time.enableCountry')}
          </Button>
          {editing ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setCountry('');
                setNotice({});
              }}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    </SettingsCard>
  );
}

function SiteDialog({ loc, onClose, onSaved }: { loc: Location; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const action = useAction();
  const [v, setV] = React.useState({ lat: loc.geofence ? String(loc.geofence.lat) : '', lng: loc.geofence ? String(loc.geofence.lng) : '', radius: String(loc.geofence?.radiusMetres ?? 150) });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await action.run(() => api(`/v1/org/locations/${loc.id}`, { method: 'PATCH', json: { geofence: { lat: Number(v.lat), lng: Number(v.lng), radiusMetres: Number(v.radius) } } }), t('admin.saved'))) onSaved();
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('admin.time.siteTitle', { name: loc.name })} description={t('admin.time.siteBody')} closeLabel={t('common.close')}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="site-lat" label={t('admin.time.latitude')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={-90} max={90} step="any" value={v.lat} onChange={(e) => setV({ ...v, lat: e.target.value })} />}
            </Field>
            <Field id="site-lng" label={t('admin.time.longitude')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={-180} max={180} step="any" value={v.lng} onChange={(e) => setV({ ...v, lng: e.target.value })} />}
            </Field>
          </div>
          <Field id="site-radius" label={t('admin.time.radius')} hint={t('admin.time.radiusHint')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" required min={25} max={5000} step={1} className="sm:w-40" value={v.radius} onChange={(e) => setV({ ...v, radius: e.target.value })} />}
          </Field>
          <FormError message={action.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={action.busy}>
              {t('common.save')}
            </Button>
            {loc.geofence ? (
              <Button type="button" variant="secondary" onClick={async () => (await action.run(() => api(`/v1/org/locations/${loc.id}`, { method: 'PATCH', json: { geofence: null } }), t('admin.saved'))) && onSaved()}>
                {t('admin.time.clearSite')}
              </Button>
            ) : null}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sites({ countries }: { countries: string[] }) {
  const t = useT();
  const locale = useLocale();
  const locations = useOrg<Location>('locations');
  const [editing, setEditing] = React.useState<Location | null>(null);
  const n = (x: number, digits: number) => formatNumber(x, locale, { maximumFractionDigits: digits });
  return (
    <SettingsCard id="sites" title={t('admin.time.sitesTitle')} description={t('admin.time.sitesBody')}>
      {!locations.data ? (
        <Skeleton className="h-20" />
      ) : locations.data.length === 0 ? (
        <EmptyState icon={<MapPin aria-hidden />} title={t('admin.time.noSites')} />
      ) : (
        <Table dense>
          <THead>
            <tr>
              <TH>{t('rota.location')}</TH>
              <TH>{t('admin.time.country')}</TH>
              <TH>{t('admin.time.siteArea')}</TH>
              <TH>
                <span className="sr-only">{t('common.actions')}</span>
              </TH>
            </tr>
          </THead>
          <tbody>
            {locations.data.map((l) => (
              <TR key={l.id}>
                <TD className="font-semibold">{l.name}</TD>
                <TD>
                  {l.country} {countries.includes(l.country) ? <Badge tone="success">{t('admin.time.geofenced')}</Badge> : null}
                </TD>
                <TD>{l.geofence ? t('admin.time.siteAreaText', { lat: n(l.geofence.lat, 5), lng: n(l.geofence.lng, 5), radius: n(l.geofence.radiusMetres, 0) }) : t('admin.time.siteNotSet')}</TD>
                <TD className="text-right">
                  <Button size="sm" variant="ghost" aria-label={t('admin.time.editSite', { name: l.name })} onClick={() => setEditing(l)}>
                    <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('common.edit')}
                  </Button>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
      {editing ? (
        <SiteDialog
          loc={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            locations.reload();
          }}
        />
      ) : null}
    </SettingsCard>
  );
}

const LIMITS = {
  maxFailedAttempts: [3, 20],
  lockoutMinutes: [1, 1440],
  attemptsPerMinute: [5, 600],
  maxOfflineHours: [1, 720],
  varianceToleranceMinutes: [0, 240],
} as const;

function Clocking({ s, onSaved }: { s: TimeSettings; onSaved: () => void }) {
  const t = useT();
  const action = useAction();
  const [v, setV] = React.useState<Record<keyof typeof LIMITS, string>>({
    maxFailedAttempts: String(s.kiosk.maxFailedAttempts),
    lockoutMinutes: String(s.kiosk.lockoutMinutes),
    attemptsPerMinute: String(s.kiosk.attemptsPerMinute),
    maxOfflineHours: String(s.clock.maxOfflineHours),
    varianceToleranceMinutes: String(s.timesheets.varianceToleranceMinutes),
  });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = (k: keyof typeof LIMITS) => Number(v[k]);
    const body = { kiosk: { maxFailedAttempts: n('maxFailedAttempts'), lockoutMinutes: n('lockoutMinutes'), attemptsPerMinute: n('attemptsPerMinute') }, clock: { maxOfflineHours: n('maxOfflineHours') }, timesheets: { varianceToleranceMinutes: n('varianceToleranceMinutes') } };
    if (await action.run(() => put(body), t('admin.saved'))) onSaved();
  }
  return (
    <SettingsCard
      id="clocking"
      title={t('admin.time.clockingTitle')}
      description={t('admin.time.clockingBody')}
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/app/clock" className="no-underline">
            <Monitor aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.time.manageKiosks')}
          </Link>
        </Button>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(LIMITS) as Array<keyof typeof LIMITS>).map((k) => (
            <Field key={k} id={`clock-${k}`} label={t(`admin.time.${k}`)} hint={t('admin.policy.range', { min: LIMITS[k][0], max: LIMITS[k][1] })}>
              {(p) => <Input {...p} type="number" inputMode="numeric" required min={LIMITS[k][0]} max={LIMITS[k][1]} step={1} value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />}
            </Field>
          ))}
        </div>
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          {t('common.save')}
        </Button>
      </form>
    </SettingsCard>
  );
}

/** Time and attendance: working-time rule strictness, geofencing per country, kiosks and clocking. */
export default function TimeSettingsPage() {
  const t = useT();
  const has = usePermission();
  const settings = useApi<TimeSettings>('/v1/settings/time');
  const s = settings.data;
  return (
    <>
      <PageHeader title={t('admin.section.time.title')} lead={t('admin.time.lead')} />
      {!s ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <WorkingTime s={s} onSaved={settings.reload} />
          <Geofencing s={s} onSaved={settings.reload} />
          {has('org.manage') ? <Sites countries={s.geofence.countries} /> : null}
          <Clocking s={s} onSaved={settings.reload} />
        </>
      )}
    </>
  );
}
