'use client';
import * as React from 'react';
import { BellRing } from 'lucide-react';
import { Button, Card, CardTitle, useToast } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

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
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await api('/v1/me/push-subscriptions', { method: 'POST', json: { endpoint: json.endpoint, keys: json.keys } });
    setState('subscribed');
  }

  async function test() {
    const r = await api<{ sent: number }>('/v1/me/push-test', { method: 'POST' });
    toast({ title: t('app.notifications.testSent', { count: r.sent }) });
  }

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-6">
      <h1 className="text-title-2">{t('app.notifications.title')}</h1>
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
    </div>
  );
}
