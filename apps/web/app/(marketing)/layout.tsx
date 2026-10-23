import Link from 'next/link';
import { MarketingNav } from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { LocaleSwitch, ThemeSwitch } from '@/components/client';
import { serverContext } from '@/lib/server';

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const { t, theme } = await serverContext();
  return (
    <>
      <MarketingNav>
        <Link href="/" className="no-underline" aria-label={t('common.appName')}>
          <Logo label={t('common.appName')} />
        </Link>
        <nav aria-label={t('marketing.nav.label')} className="ml-auto flex items-center gap-5 text-footnote">
          <Link href="/#features" className="hidden text-text no-underline hover:text-accent sm:inline">
            {t('marketing.nav.product')}
          </Link>
          <Link href="/pricing" className="hidden text-text no-underline hover:text-accent sm:inline">
            {t('marketing.nav.pricing')}
          </Link>
          <Link href="/trust" className="hidden text-text no-underline hover:text-accent sm:inline">
            {t('marketing.nav.trust')}
          </Link>
          <Link href="/signin" className="text-text no-underline hover:text-accent">
            {t('marketing.nav.signIn')}
          </Link>
          <Link
            href="/signup"
            className="rounded-pill bg-accent px-3 py-1 font-semibold text-on-accent no-underline hover:bg-accent-hover"
          >
            {t('marketing.nav.getStarted')}
          </Link>
        </nav>
      </MarketingNav>
      <main id="main">{children}</main>
      <footer className="border-t border-border bg-surface px-4 py-10 text-footnote text-text-secondary md:px-6">
        <div className="mx-auto flex max-w-[var(--content-width)] flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <p>{t('marketing.footer.copyright', { year: new Date().getUTCFullYear() })}</p>
          <nav aria-label={t('marketing.footer.label')} className="flex flex-wrap gap-4">
            <Link href="/trust" className="text-text-secondary">
              {t('marketing.footer.trust')}
            </Link>
            <Link href="/trust/subprocessors" className="text-text-secondary">
              {t('marketing.footer.subprocessors')}
            </Link>
            <Link href="/status" className="text-text-secondary">
              {t('marketing.footer.status')}
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <LocaleSwitch />
            <ThemeSwitch initial={theme} />
          </div>
        </div>
      </footer>
    </>
  );
}
