'use client';
import * as React from 'react';
import Link from 'next/link';
import { BellRing, CheckCheck, Inbox } from 'lucide-react';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';

interface Note {
  id: string;
  kind: string;
  category: string;
  title: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}
interface Prefs {
  email: boolean;
  push: boolean;
  categories: Record<string, { email: boolean; push: boolean }>;
  available: string[];
  pushConfigured: boolean;
}

/** My in-app notifications (newest first), with mark-as-read. */
function NotificationList() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [cursor, setCursor] = React.useState<string | null>(null);
  const page = useApi<{ data: Note[]; unread: number; nextCursor: string | null }>(
    `/v1/me/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const [items, setItems] = React.useState<Note[]>([]);
  const [unread, setUnread] = React.useState(0);
  React.useEffect(() => {
    if (!page.data) return;
    setItems((cur) =>
      cursor ? [...cur, ...page.data!.data.filter((n) => !cur.some((c) => c.id === n.id))] : page.data!.data,
    );
    setUnread(page.data.unread);
  }, [page.data, cursor]);
  async function mark(body: { ids?: string[]; all?: boolean }) {
    await api('/v1/me/notifications/read', { method: 'POST', json: body });
    setItems((cur) => cur.map((n) => (body.all || body.ids?.includes(n.id) ? { ...n, read: true } : n)));
    setUnread((u) => (body.all ? 0 : Math.max(0, u - (body.ids?.length ?? 0))));
  }
  if (!page.data && !items.length)
    return (
      <section aria-labelledby="inbox-h" className="flex flex-col gap-3">
        <h2 id="inbox-h" className="mr-auto text-title-3">
          {t('ess.notifications.inbox')}
        </h2>
        <Skeleton className="h-40 w-full" />
      </section>
    );
  return (
    <section aria-labelledby="inbox-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="inbox-h" className="mr-auto text-title-3">
          {t('ess.notifications.inbox')}
        </h2>
        <span className="text-footnote text-text-secondary" role="status">
          {t('ess.notifications.unread', { n: unread })}
        </span>
        <Button size="sm" variant="secondary" disabled={!unread} onClick={() => mark({ all: true })}>
          <CheckCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('ess.notifications.markAll')}
        </Button>
      </div>
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${n.read ? 'border-border' : 'border-accent'}`}
            >
              {!n.read ? <span className="sr-only">{t('ess.notifications.new')}</span> : null}
              <span className="mr-auto min-w-0 flex-1 text-callout">
                {n.link ? (
                  <Link href={n.link} onClick={() => !n.read && void mark({ ids: [n.id] })}>
                    {n.title}
                  </Link>
                ) : (
                  n.title
                )}
              </span>
              <span className="text-footnote text-text-secondary">
                {formatDateTime(n.createdAt, locale, zone)}
              </span>
              {!n.read ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => mark({ ids: [n.id] })}
                  aria-label={t('ess.notifications.markReadNamed', { title: n.title })}
                >
                  {t('ess.notifications.markRead')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Inbox aria-hidden />} title={t('ess.notifications.empty')} />
      )}
      {page.data?.nextCursor ? (
        <Button size="sm" variant="ghost" className="w-fit" onClick={() => setCursor(page.data!.nextCursor)}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}

/** Which notifications reach me by email and web push (in-app notifications are always kept). */
function Preferences() {
  const t = useT();
  const toast = useToast();
  const prefs = useApi<Prefs>('/v1/me/notification-preferences');
  async function save(body: {
    email?: boolean;
    push?: boolean;
    categories?: Record<string, { email?: boolean; push?: boolean }>;
  }) {
    // optimistic: the checkbox reflects the choice at once; the server's answer then replaces it
    prefs.setData((cur) => {
      if (!cur) return cur;
      const categories = { ...cur.categories };
      for (const [c, v] of Object.entries(body.categories ?? {}))
        categories[c] = { ...(categories[c] ?? { email: true, push: true }), ...v };
      return {
        ...cur,
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.push !== undefined ? { push: body.push } : {}),
        categories,
      };
    });
    try {
      const next = await api<Omit<Prefs, 'available' | 'pushConfigured'>>('/v1/me/notification-preferences', {
        method: 'PUT',
        json: body,
      });
      prefs.setData((cur) => (cur ? { ...cur, ...next } : cur));
      toast({ title: t('ess.notifications.prefsSaved'), tone: 'success' });
    } catch {
      toast({ title: t('common.error'), tone: 'danger' });
      prefs.reload();
    }
  }
  if (!prefs.data)
    return (
      <section aria-labelledby="prefs-h" className="flex flex-col gap-3">
        <h2 id="prefs-h" className="text-title-3">
          {t('ess.notifications.prefsTitle')}
        </h2>
        <p className="text-callout text-text-secondary">{t('ess.notifications.prefsIntro')}</p>
        <Skeleton className="h-40 w-full" />
      </section>
    );
  const p = prefs.data;
  const box = 'h-5 w-5 accent-[var(--color-accent)]';
  return (
    <section aria-labelledby="prefs-h" className="flex flex-col gap-3">
      <h2 id="prefs-h" className="text-title-3">
        {t('ess.notifications.prefsTitle')}
      </h2>
      <p className="text-callout text-text-secondary">{t('ess.notifications.prefsIntro')}</p>
      <div className="flex flex-wrap gap-6">
        <label className="flex min-h-11 items-center gap-2 text-callout">
          <input
            type="checkbox"
            className={box}
            checked={p.email}
            onChange={(e) => save({ email: e.target.checked })}
          />
          {t('ess.notifications.allEmail')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-callout">
          <input
            type="checkbox"
            className={box}
            checked={p.push}
            disabled={!p.pushConfigured}
            onChange={(e) => save({ push: e.target.checked })}
          />
          {t('ess.notifications.allPush')}
        </label>
      </div>
      <Table dense>
        <caption className="sr-only">{t('ess.notifications.prefsTitle')}</caption>
        <THead>
          <tr>
            <TH>{t('ess.notifications.category')}</TH>
            <TH className="text-center">{t('ess.notifications.email')}</TH>
            <TH className="text-center">{t('ess.notifications.push')}</TH>
          </tr>
        </THead>
        <tbody>
          {p.available.map((c) => {
            const v = p.categories[c] ?? { email: true, push: true };
            const name = t(`ess.notifications.cat.${c}`);
            return (
              <TR key={c}>
                <TD>{name}</TD>
                <TD className="text-center">
                  <input
                    type="checkbox"
                    className={box}
                    aria-label={t('ess.notifications.emailFor', { category: name })}
                    checked={p.email && v.email}
                    disabled={!p.email}
                    onChange={(e) => save({ categories: { [c]: { email: e.target.checked } } })}
                  />
                </TD>
                <TD className="text-center">
                  <input
                    type="checkbox"
                    className={box}
                    aria-label={t('ess.notifications.pushFor', { category: name })}
                    checked={p.push && v.push}
                    disabled={!p.push || !p.pushConfigured}
                    onChange={(e) => save({ categories: { [c]: { push: e.target.checked } } })}
                  />
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}

const b64ToBytes = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export default function NotificationsPage() {
  const t = useT();
  const toast = useToast();
  const [state, setState] = React.useState<'idle' | 'unsupported' | 'subscribed' | 'denied'>('idle');

  React.useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) setState('unsupported');
  }, []);

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return setState('denied');
    const { publicKey } = await api<{ publicKey: string | null }>('/v1/push/vapid-public-key');
    if (!publicKey) return setState('unsupported');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(publicKey),
    });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await api('/v1/me/push-subscriptions', {
      method: 'POST',
      json: { endpoint: json.endpoint, keys: json.keys },
    });
    setState('subscribed');
  }

  async function test() {
    const r = await api<{ sent: number }>('/v1/me/push-test', { method: 'POST' });
    toast({ title: t('app.notifications.testSent', { count: r.sent }) });
  }

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-8">
      <div>
        <h1 className="text-title-2">{t('app.notifications.title')}</h1>
        <p className="mt-1 text-callout text-text-secondary">{t('app.notifications.intro')}</p>
      </div>
      <NotificationList />
      <Card>
        <div className="flex items-center gap-3">
          <BellRing aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
          <CardTitle>{t('app.notifications.pushTitle')}</CardTitle>
        </div>
        <p className="mt-2 text-callout text-text-secondary">{t(`app.notifications.state.${state}`)}</p>
        <div className="mt-4 flex gap-3">
          <Button onClick={subscribe} disabled={state === 'unsupported' || state === 'subscribed'}>
            {t('app.notifications.enable')}
          </Button>
          <Button variant="secondary" onClick={test} disabled={state !== 'subscribed'}>
            {t('app.notifications.test')}
          </Button>
        </div>
      </Card>
      <Preferences />
    </div>
  );
}
