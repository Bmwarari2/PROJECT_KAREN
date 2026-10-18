'use client';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card, CardTitle, EmptyState, buttonVariants } from '@thapsus/ui';
import { useApi } from '@/lib/use-api';
import { useT } from '@/lib/i18n-client';
import { useSession } from './shell';

export default function AppHome() {
  const t = useT();
  const s = useSession();
  // people with an employee record who have not started yet are pointed at their pre-start portal
  const onboarding = useApi<{ employee: { status: string } }>(s?.employeeId ? '/v1/me/onboarding' : null);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('app.home.greeting', { name: s?.displayName.split(' ')[0] ?? '' })}</h1>
      {onboarding.data?.employee.status === 'pre_start' ? (
        <Card>
          <CardTitle>{t('app.home.welcomeTitle')}</CardTitle>
          <p className="mt-2 text-callout text-text-secondary">{t('app.home.welcomeBody')}</p>
          <Link href="/app/welcome" className={buttonVariants({ size: 'sm' }) + ' mt-3 no-underline'}>
            {t('app.home.openWelcome')}
          </Link>
        </Card>
      ) : null}
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
