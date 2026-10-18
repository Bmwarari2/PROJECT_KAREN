'use client';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card, CardTitle, EmptyState } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useSession } from './shell';

export default function AppHome() {
  const t = useT();
  const s = useSession();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('app.home.greeting', { name: s?.displayName.split(' ')[0] ?? '' })}</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>{t('app.home.security')}</CardTitle>
          <p className="mt-2 text-callout text-text-secondary">{s?.mfaVerified ? t('app.home.mfaOn') : t('app.home.mfaOff')}</p>
          <Link href="/app/security" className="mt-3 inline-block text-callout">
            {t('app.home.manageSecurity')}
          </Link>
        </Card>
        <Card>
          <CardTitle>{t('app.home.roles')}</CardTitle>
          <p className="mt-2 text-callout text-text-secondary">{s?.roles.map((r) => t(`roles.${r}`)).join(', ')}</p>
        </Card>
        <Card>
          <CardTitle>{t('app.home.region')}</CardTitle>
          <p className="mt-2 text-callout text-text-secondary">{t('app.home.regionBody')}</p>
        </Card>
      </div>
      <EmptyState icon={<Sparkles aria-hidden />} title={t('app.home.emptyTitle')} body={t('app.home.emptyBody')} />
    </div>
  );
}
