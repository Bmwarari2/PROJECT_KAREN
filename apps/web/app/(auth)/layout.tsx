import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { t } = await serverContext();
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="px-4 py-5 md:px-8">
        <Link href="/" className="no-underline" aria-label={t('common.appName')}>
          <Logo label={t('common.appName')} />
        </Link>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 md:pt-16">
        <div className="w-full max-w-[440px] rounded-xl bg-surface-raised p-6 shadow-md md:p-10">
          <Messages ns={['auth.fields', 'auth.signIn', 'auth.mfa', 'auth.signUp', 'auth.find', 'auth.magic']}>
            {children}
          </Messages>
        </div>
      </main>
    </div>
  );
}
